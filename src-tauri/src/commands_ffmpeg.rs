use std::fs;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::error::AppError;
use crate::utils::app_data_dir;

/// Executables the app needs from the ffmpeg archive. `ffprobe` is not optional:
/// `stt_engine._probe_duration` uses it to decide whether a file is long enough
/// to need 30-minute chunking, and without it that guard never fires.
const REQUIRED_BINARIES: [&str; 2] = ["ffmpeg.exe", "ffprobe.exe"];

fn ffmpeg_dir() -> Result<PathBuf, AppError> {
    let dir = app_data_dir()?.join("bin");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::Config(format!("Failed to create bin dir: {}", e)))?;
    Ok(dir)
}

fn ffmpeg_path() -> Result<PathBuf, AppError> {
    Ok(ffmpeg_dir()?.join("ffmpeg.exe"))
}

/// Extract every entry whose name ends with one of `suffixes` into `dest_dir`,
/// naming each output after the suffix's file name. Errors if any suffix is
/// unmatched — a partial install is worse than none, because the missing binary
/// only shows up later as a silently skipped code path.
pub(crate) fn extract_binaries<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    dest_dir: &Path,
    suffixes: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    let wanted: Vec<(String, String, String)> = suffixes
        .iter()
        .map(|s| {
            let file_name = s.rsplit('/').next().unwrap_or(s).to_string();
            (s.clone(), s.replace('/', "\\"), file_name)
        })
        .collect();

    let mut written: Vec<PathBuf> = Vec::new();
    let mut missing: Vec<&str> = wanted.iter().map(|(s, _, _)| s.as_str()).collect();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Setup(format!("Failed to read zip entry: {}", e)))?;
        let name = entry.name().to_string();

        let hit = wanted
            .iter()
            .find(|(fwd, back, _)| name.ends_with(fwd) || name.ends_with(back));
        let Some((fwd, _, file_name)) = hit else {
            continue;
        };
        if !missing.contains(&fwd.as_str()) {
            continue; // already extracted; ignore duplicates
        }

        let out_path = dest_dir.join(file_name);
        let mut outfile = fs::File::create(&out_path)
            .map_err(|e| AppError::Setup(format!("Failed to create {}: {}", file_name, e)))?;
        std::io::copy(&mut entry, &mut outfile)
            .map_err(|e| AppError::Setup(format!("Failed to extract {}: {}", file_name, e)))?;

        missing.retain(|s| *s != fwd.as_str());
        written.push(out_path);
    }

    if !missing.is_empty() {
        return Err(AppError::Setup(format!(
            "Archive is missing required binaries: {}",
            missing.join(", ")
        )));
    }
    Ok(written)
}

fn all_local_binaries_present() -> Result<bool, AppError> {
    let dir = ffmpeg_dir()?;
    Ok(REQUIRED_BINARIES.iter().all(|b| dir.join(b).exists()))
}

fn on_system_path(exe: &str) -> bool {
    matches!(
        crate::utils::hidden_command("where").arg(exe).output(),
        Ok(o) if o.status.success()
    )
}

/// Check if ffmpeg *and* ffprobe are available (either in app bin or system PATH).
/// Both are required; reporting "ready" with ffprobe missing is what let long-file
/// chunking silently stop running.
#[tauri::command]
pub fn check_ffmpeg() -> Result<bool, AppError> {
    if all_local_binaries_present()? {
        return Ok(true);
    }
    Ok(REQUIRED_BINARIES
        .iter()
        .all(|b| on_system_path(b.trim_end_matches(".exe"))))
}

/// Get the ffmpeg executable path (app-local or system)
#[tauri::command]
pub fn get_ffmpeg_path() -> Result<String, AppError> {
    let local = ffmpeg_path()?;
    if local.exists() {
        return Ok(local.to_string_lossy().to_string());
    }
    // Fallback to system ffmpeg
    Ok("ffmpeg".to_string())
}

/// Download ffmpeg essentials to app-local bin directory
#[tauri::command]
pub async fn download_ffmpeg(app: AppHandle) -> Result<String, AppError> {
    use tauri::Emitter;

    let dest_dir = ffmpeg_dir()?;
    let dest_path = dest_dir.join("ffmpeg.exe");

    // Keyed on *all* required binaries, not just ffmpeg.exe. Installs made before
    // ffprobe was extracted must re-run, otherwise they stay half-installed forever.
    if all_local_binaries_present()? {
        return Ok(dest_path.to_string_lossy().to_string());
    }

    let manifest = crate::integrity::load_integrity_manifest(&app)?;
    let zip_path = dest_dir.join("ffmpeg-download.zip");

    let _ = app.emit("ffmpeg-download-progress", "Downloading ffmpeg...");
    // Fetches the pinned third-party URL — deliberately the only source, see
    // `integrity::FfmpegEntry` — and verifies its sha256 before unpacking, so a
    // tampered or corrupt archive never becomes an executable we then run.
    crate::integrity::download_verified(
        &manifest.ffmpeg.urls(),
        &manifest.ffmpeg.sha256,
        &zip_path,
    )
    .await?;

    let _ = app.emit("ffmpeg-download-progress", "Extracting ffmpeg...");

    let file = fs::File::open(&zip_path).map_err(|e| {
        AppError::Setup(format!("Failed to open zip: {}", e))
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| {
        AppError::Setup(format!("Failed to read zip: {}", e))
    })?;

    let extracted = extract_binaries(&mut archive, &dest_dir, &manifest.ffmpeg.exe_suffixes);

    // Clean up zip
    let _ = fs::remove_file(&zip_path);

    let extracted = extracted?;
    log::info!("ffmpeg binaries installed: {:?}", extracted);
    let _ = app.emit("ffmpeg-download-progress", "Complete");

    Ok(dest_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    /// Mirrors the real archives: a versioned top-level directory, a `bin/`
    /// subdirectory, and extra entries we must ignore (ffplay, docs).
    fn make_zip(entries: &[(&str, &[u8])]) -> Cursor<Vec<u8>> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, body) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(body).unwrap();
            }
            w.finish().unwrap();
        }
        buf.set_position(0);
        buf
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("localsub-ffmpeg-test-{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn suffixes() -> Vec<String> {
        vec!["bin/ffmpeg.exe".to_string(), "bin/ffprobe.exe".to_string()]
    }

    #[test]
    fn extracts_ffmpeg_and_ffprobe_ignoring_other_entries() {
        let zip = make_zip(&[
            ("ffmpeg-8.1.2-essentials_build/README.txt", b"docs"),
            ("ffmpeg-8.1.2-essentials_build/bin/ffplay.exe", b"PLAY"),
            ("ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe", b"FFMPEG"),
            ("ffmpeg-8.1.2-essentials_build/bin/ffprobe.exe", b"FFPROBE"),
        ]);
        let mut archive = zip::ZipArchive::new(zip).unwrap();
        let dir = scratch_dir("both");

        let written = extract_binaries(&mut archive, &dir, &suffixes()).unwrap();

        assert_eq!(written.len(), 2);
        assert_eq!(fs::read(dir.join("ffmpeg.exe")).unwrap(), b"FFMPEG");
        assert_eq!(fs::read(dir.join("ffprobe.exe")).unwrap(), b"FFPROBE");
        assert!(!dir.join("ffplay.exe").exists(), "ffplay must not be extracted");
    }

    /// The regression this whole change exists for: a build that ships ffmpeg but
    /// no ffprobe must fail loudly. Silently installing half of it disables
    /// long-file chunking without any error surfacing to the user.
    #[test]
    fn missing_ffprobe_is_an_error_not_a_partial_install() {
        let zip = make_zip(&[("ffmpeg-x/bin/ffmpeg.exe", b"FFMPEG")]);
        let mut archive = zip::ZipArchive::new(zip).unwrap();
        let dir = scratch_dir("missing");

        let err = extract_binaries(&mut archive, &dir, &suffixes()).unwrap_err();
        assert!(
            format!("{err:?}").contains("ffprobe"),
            "error must name the missing binary, got: {err:?}"
        );
    }

    #[test]
    fn accepts_backslash_separated_entry_names() {
        let zip = make_zip(&[
            ("ffmpeg-x\\bin\\ffmpeg.exe", b"FFMPEG"),
            ("ffmpeg-x\\bin\\ffprobe.exe", b"FFPROBE"),
        ]);
        let mut archive = zip::ZipArchive::new(zip).unwrap();
        let dir = scratch_dir("backslash");

        extract_binaries(&mut archive, &dir, &suffixes()).unwrap();
        assert!(dir.join("ffmpeg.exe").exists());
        assert!(dir.join("ffprobe.exe").exists());
    }
}
