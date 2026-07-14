//! Supply-chain integrity: shared sha256 verification + the bundled
//! `integrity.json` manifest of pinned download URLs and hashes.

use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::AppError;

#[derive(Debug, Clone, Deserialize)]
pub struct IntegrityManifest {
    pub ffmpeg: FfmpegEntry,
    pub llama_cpp: LlamaCpp,
}

/// ffmpeg is deliberately single-sourced — note the absent `mirror_url`.
///
/// Every Windows ffmpeg build we can pin is GPLv3. GPL obligations attach to
/// *conveying* (GPLv3 §0: "Mere interaction with a user through a computer
/// network, with no transfer of a copy, is not conveying"). Pointing at a
/// third-party URL keeps the bytes flowing from their server to the user, so
/// we never become a distributor. **Hosting a mirror makes us one** — and the
/// Corresponding Source we would then owe is unsatisfiable for a binary
/// somebody else built (it must "correspond exactly").
///
/// `deny_unknown_fields` is what makes this stick: re-adding `mirror_url` to
/// `integrity.json` fails to parse instead of being silently ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FfmpegEntry {
    pub url: String,
    pub sha256: String,
    /// Suffixes used to locate the executables inside the zip, e.g.
    /// `["bin/ffmpeg.exe", "bin/ffprobe.exe"]`. Every one of them must be
    /// extracted: `ffprobe` alone decides whether long-file chunking runs, and a
    /// missing one degrades silently rather than failing loudly.
    pub exe_suffixes: Vec<String>,
}

impl FfmpegEntry {
    /// The single upstream URL. Unlike [`LlamaWheel`] there is no mirror
    /// fallback; if gyan removes the release, setup falls back to a system
    /// ffmpeg on PATH and the user can install one themselves.
    pub fn urls(&self) -> Vec<String> {
        vec![self.url.clone()]
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlamaCpp {
    pub cuda: LlamaWheel,
    pub cpu: LlamaWheel,
}

/// Unlike [`FfmpegEntry`], mirroring these is fine: llama-cpp-python is MIT,
/// so re-hosting the wheel carries no source-offer obligation.
#[derive(Debug, Clone, Deserialize)]
pub struct LlamaWheel {
    pub url: String,
    /// Optional self-hosted mirror tried if the upstream `url` is unavailable.
    #[serde(default)]
    pub mirror_url: Option<String>,
    pub sha256: String,
}

impl LlamaWheel {
    /// Download URLs in priority order: upstream first, then the mirror.
    pub fn urls(&self) -> Vec<String> {
        let mut v = vec![self.url.clone()];
        if let Some(m) = &self.mirror_url {
            v.push(m.clone());
        }
        v
    }
}

/// Lowercase hex sha256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Path of the bundled `integrity.json`. Exposed so `setup_manager` can hash the
/// raw bytes into the setup marker: the pins it holds decide what gets installed.
pub fn manifest_path(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    app.path()
        .resolve("integrity.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Config(format!("Failed to resolve integrity.json: {}", e)))
}

/// Loads the bundled `integrity.json` manifest.
pub fn load_integrity_manifest(app: &AppHandle) -> Result<IntegrityManifest, AppError> {
    let path = manifest_path(app)?;
    let data = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Config(format!("Failed to read integrity.json: {}", e)))?;
    serde_json::from_str(&data)
        .map_err(|e| AppError::Config(format!("Failed to parse integrity.json: {}", e)))
}

/// Verifies a file's sha256 against `expected` (lowercase hex). Returns Ok(true)
/// on match. An empty or "placeholder" expected hash skips verification (used by
/// the model downloader for companion files without catalog hashes).
pub async fn verify_sha256(path: &Path, expected: &str) -> Result<bool, AppError> {
    if expected == "placeholder" || expected.is_empty() {
        log::warn!(
            "Skipping SHA-256 verification for {:?}: hash is '{}'",
            path.file_name().unwrap_or_default(),
            expected
        );
        return Ok(true);
    }

    let path = path.to_path_buf();
    let expected = expected.to_string();

    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .map_err(|e| AppError::Download(format!("Failed to open file for hash: {}", e)))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            use std::io::Read;
            let n = file
                .read(&mut buf)
                .map_err(|e| AppError::Download(format!("Failed to read file for hash: {}", e)))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let hash = format!("{:x}", hasher.finalize());
        Ok(hash == expected)
    })
    .await
    .map_err(|e| AppError::Download(format!("Hash task panicked: {}", e)))?
}

/// Downloads from the first URL that succeeds (primary first, then mirrors),
/// writes the body to `dest`, and verifies its sha256. A source that returns
/// a non-success status, fails to transfer, or whose bytes don't match the
/// hash is skipped and the next URL is tried. Returns the URL that worked.
pub async fn download_verified(
    urls: &[String],
    sha256: &str,
    dest: &Path,
) -> Result<String, AppError> {
    let client = reqwest::Client::new();
    let mut last_err = String::from("no urls provided");

    for url in urls {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                Ok(bytes) => {
                    std::fs::write(dest, &bytes).map_err(|e| {
                        AppError::Setup(format!("Failed to write download: {}", e))
                    })?;
                    match verify_sha256(dest, sha256).await? {
                        true => return Ok(url.clone()),
                        false => {
                            let _ = std::fs::remove_file(dest);
                            last_err = format!("sha256 mismatch from {}", url);
                            log::warn!("[integrity] {}", last_err);
                        }
                    }
                }
                Err(e) => {
                    last_err = format!("read failed from {}: {}", url, e);
                    log::warn!("[integrity] {}", last_err);
                }
            },
            Ok(resp) => {
                last_err = format!("HTTP {} from {}", resp.status(), url);
                log::warn!("[integrity] {}", last_err);
            }
            Err(e) => {
                last_err = format!("request failed for {}: {}", url, e);
                log::warn!("[integrity] {}", last_err);
            }
        }
    }

    Err(AppError::Setup(format!(
        "All download sources failed ({})",
        last_err
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_of_empty_is_known_constant() {
        // sha256("") is well-known.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_hex_of_abc() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// The bundled manifest — not a fixture. The MIT wheels must each carry a
    /// mirror that actually differs from upstream: `urls()` returns
    /// `[url, mirror_url]`, so a mirror equal to the upstream URL retries the
    /// same dead host and the fallback silently does nothing. The CUDA wheel
    /// shipped that way for one release.
    #[test]
    fn llama_cpp_mirrors_are_real_fallbacks() {
        let m: IntegrityManifest =
            serde_json::from_str(include_str!("../resources/integrity.json")).unwrap();

        for (name, url, mirror) in [
            ("llama_cpp.cuda", &m.llama_cpp.cuda.url, &m.llama_cpp.cuda.mirror_url),
            ("llama_cpp.cpu", &m.llama_cpp.cpu.url, &m.llama_cpp.cpu.mirror_url),
        ] {
            let mirror = mirror
                .as_ref()
                .unwrap_or_else(|| panic!("{name}: no mirror_url — upstream removal breaks setup"));
            assert_ne!(mirror, url, "{name}: mirror_url duplicates the upstream url");
        }
    }

    /// The licensing invariant, checked against the bundled manifest: we must
    /// not serve ffmpeg bytes ourselves. See [`FfmpegEntry`] for why. A mirror
    /// field can no longer even parse, so what's left to guard is the URL
    /// pointing away from our own release assets.
    #[test]
    fn bundled_ffmpeg_is_not_self_hosted() {
        let m: IntegrityManifest =
            serde_json::from_str(include_str!("../resources/integrity.json")).unwrap();

        assert_eq!(m.ffmpeg.urls().len(), 1, "ffmpeg must have exactly one source");
        assert!(
            !m.ffmpeg.url.contains("localsub/localsub"),
            "ffmpeg must be fetched from a third party, not our own releases: {}",
            m.ffmpeg.url
        );
    }

    /// Re-adding a mirror to `integrity.json` must fail loudly. Without
    /// `deny_unknown_fields` serde would drop the key and the author would
    /// believe a fallback existed.
    #[test]
    fn ffmpeg_entry_rejects_a_mirror_url() {
        let json = r#"{
          "version": 1,
          "ffmpeg": {
            "url": "https://up/ff.zip",
            "mirror_url": "https://mir/ff.zip",
            "sha256": "aa",
            "exe_suffixes": ["bin/ffmpeg.exe"]
          },
          "llama_cpp": {
            "cuda": { "url": "https://up/cu.whl", "sha256": "bb" },
            "cpu":  { "url": "https://up/cpu.whl", "sha256": "cc" }
          }
        }"#;
        let err = serde_json::from_str::<IntegrityManifest>(json).unwrap_err();
        assert!(
            err.to_string().contains("mirror_url"),
            "error must name the offending field, got: {err}"
        );
    }

    #[test]
    fn manifest_parses_full_shape() {
        let json = r#"{
          "version": 1,
          "ffmpeg": { "url": "https://x/ff.zip", "sha256": "aa", "exe_suffixes": ["bin/ffmpeg.exe"] },
          "llama_cpp": {
            "cuda": { "url": "https://x/cu.whl", "sha256": "bb" },
            "cpu":  { "url": "https://x/cpu.whl", "sha256": "cc" }
          }
        }"#;
        let m: IntegrityManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.ffmpeg.exe_suffixes, vec!["bin/ffmpeg.exe".to_string()]);
        assert_eq!(m.llama_cpp.cuda.sha256, "bb");
        assert_eq!(m.llama_cpp.cpu.url, "https://x/cpu.whl");
        assert_eq!(m.ffmpeg.urls(), vec!["https://x/ff.zip".to_string()]);
        assert!(m.llama_cpp.cuda.mirror_url.is_none());
    }

    #[test]
    fn wheel_urls_put_upstream_before_mirror() {
        let json = r#"{
          "version": 1,
          "ffmpeg": { "url": "https://up/ff.zip", "sha256": "aa", "exe_suffixes": ["bin/ffmpeg.exe"] },
          "llama_cpp": {
            "cuda": { "url": "https://up/cu.whl", "mirror_url": "https://mir/cu.whl", "sha256": "bb" },
            "cpu":  { "url": "https://up/cpu.whl", "sha256": "cc" }
          }
        }"#;
        let m: IntegrityManifest = serde_json::from_str(json).unwrap();
        assert_eq!(
            m.llama_cpp.cuda.urls(),
            vec!["https://up/cu.whl".to_string(), "https://mir/cu.whl".to_string()]
        );
        // No mirror -> single URL.
        assert_eq!(m.llama_cpp.cpu.urls(), vec!["https://up/cpu.whl".to_string()]);
        // ffmpeg is always single-sourced.
        assert_eq!(m.ffmpeg.urls(), vec!["https://up/ff.zip".to_string()]);
    }
}
