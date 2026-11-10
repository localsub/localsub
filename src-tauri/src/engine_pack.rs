//! On-demand "engine packs": the Python packages an optional STT engine needs
//! (Qwen3-ASR: torch, transformers, ...), installed the first time the user
//! downloads a model of that engine — never part of the base setup, which
//! stays a few hundred MB for everyone.
//!
//! Rule zero (docs/design/qwen3-asr-stt-engine.md §1): users never see the
//! word "torch" or run pip. The pack installs as part of the model download,
//! hash-locked like the base environment (CLAUDE.md §8).
//!
//! Layout: `%APPDATA%/LocalSub/engine-packs/<engine>/` holds the packages and a
//! `.complete` marker with the hash of the base lock + the pack lock. Install
//! goes to `<engine>.partial/` first and is renamed into place, so an
//! interrupted install never leaves a half-pack the server would import. The
//! pack contains no package the base lock pins (`scripts/lock_python.py`), and
//! the server appends the pack directory *after* the base environment on
//! `sys.path`, so one process never sees two versions of a package.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::state::SttEngine;

/// Free space required before installing a pack: the Qwen pack is ~6.7 GB
/// installed (mostly torch's CUDA libraries), plus pip's download cache.
const MIN_PACK_FREE_BYTES: u64 = 10 * 1024 * 1024 * 1024;

const MARKER: &str = ".complete";

static INSTALLING: AtomicBool = AtomicBool::new(false);

/// The lock file (in python-server/) an engine's pack installs, if it has one.
pub fn lock_file(engine: SttEngine) -> Option<&'static str> {
    match engine {
        SttEngine::FasterWhisper => None,
        SttEngine::Qwen3Asr => Some("requirements-qwen.lock"),
    }
}

pub fn packs_root() -> PathBuf {
    let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(app_data).join("LocalSub").join("engine-packs")
}

pub fn pack_dir(root: &Path, engine: SttEngine) -> PathBuf {
    root.join(engine.as_str())
}

/// Hash stored in the marker. The base lock is part of it: the pack was
/// resolved against the base versions, so a base change must reinstall it.
pub fn inputs_hash(base_lock: &str, pack_lock: &str) -> String {
    let mut h = Sha256::new();
    h.update(base_lock.as_bytes());
    h.update(b"\x00pack\x00");
    h.update(pack_lock.as_bytes());
    format!("{:x}", h.finalize())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackStatus {
    /// The engine needs no pack (faster-whisper ships in the base setup).
    NotNeeded,
    Missing,
    /// Installed for older locks; must be reinstalled before use.
    Stale,
    Ready,
}

/// Status from the marker alone (no filesystem walk).
pub fn status_of(dir: &Path, expected_hash: Option<&str>) -> PackStatus {
    let Some(expected) = expected_hash else {
        return PackStatus::NotNeeded;
    };
    match std::fs::read_to_string(dir.join(MARKER)) {
        Ok(stored) if stored.trim() == expected => PackStatus::Ready,
        Ok(_) => PackStatus::Stale,
        Err(_) => PackStatus::Missing,
    }
}

/// pip arguments: hash-locked, wheels only, no dependency resolution (the
/// lock is the full closure minus the base environment).
pub fn pip_args(lock: &Path, target: &Path) -> Vec<String> {
    vec![
        "install".into(),
        "--no-user".into(),
        "--no-deps".into(),
        "--require-hashes".into(),
        "--only-binary=:all:".into(),
        "--disable-pip-version-check".into(),
        "-r".into(),
        lock.to_string_lossy().into_owned(),
        "--target".into(),
        target.to_string_lossy().into_owned(),
    ]
}

fn read(path: &Path) -> Result<String, AppError> {
    std::fs::read_to_string(path)
        .map_err(|e| AppError::Setup(format!("Failed to read {}: {}", path.display(), e)))
}

fn expected_hash(app: &AppHandle, engine: SttEngine) -> Result<Option<String>, AppError> {
    let Some(lock) = lock_file(engine) else {
        return Ok(None);
    };
    let server = crate::setup_manager::get_python_server_dir(app)?;
    let base = read(&server.join("requirements.lock"))?;
    let pack = read(&server.join(lock))?;
    Ok(Some(inputs_hash(&base, &pack)))
}

pub fn status(app: &AppHandle, engine: SttEngine) -> Result<PackStatus, AppError> {
    let expected = expected_hash(app, engine)?;
    Ok(status_of(&pack_dir(&packs_root(), engine), expected.as_deref()))
}

/// Deletes an engine's pack (after its last model was deleted): ~6.7 GB the
/// user could not otherwise see or remove. Best effort; logged on failure.
pub fn remove(engine: SttEngine) {
    if lock_file(engine).is_none() || INSTALLING.load(Ordering::SeqCst) {
        return;
    }
    let dir = pack_dir(&packs_root(), engine);
    if dir.exists() {
        // Marker first: if the server still has the pack's DLLs loaded the
        // tree delete stops part way, and the pack must then read as missing
        // (so the next Qwen download reinstalls it), not as ready.
        let _ = std::fs::remove_file(dir.join(MARKER));
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => log::info!("[engine-pack] removed {} (no model uses it)", dir.display()),
            Err(e) => log::warn!("[engine-pack] could not remove {}: {}", dir.display(), e),
        }
    }
}

/// Progress for the frontend. The model download shows this as part of the
/// same card; `error_kind` set means the install failed.
#[derive(Debug, Clone, Serialize)]
pub struct PackProgress {
    pub engine: String,
    pub stage: &'static str,
    pub error_kind: Option<String>,
    pub message: Option<String>,
}

fn emit(app: &AppHandle, engine: SttEngine, stage: &'static str, error: Option<(&str, String)>) {
    let _ = app.emit(
        "engine-pack-progress",
        PackProgress {
            engine: engine.as_str().to_string(),
            stage,
            error_kind: error.as_ref().map(|(k, _)| k.to_string()),
            message: error.map(|(_, m)| m),
        },
    );
}

/// Installs (or reinstalls) the pack. Blocking; run off the async runtime.
/// No-op when the pack is already ready or the engine needs none.
pub fn install(app: &AppHandle, engine: SttEngine) -> Result<PackStatus, AppError> {
    let Some(expected) = expected_hash(app, engine)? else {
        return Ok(PackStatus::NotNeeded);
    };
    let root = packs_root();
    let dir = pack_dir(&root, engine);
    if status_of(&dir, Some(&expected)) == PackStatus::Ready {
        return Ok(PackStatus::Ready);
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err(AppError::InvalidState("An engine pack install is already running".into()));
    }
    let result = install_locked(app, engine, &root, &dir, &expected);
    INSTALLING.store(false, Ordering::SeqCst);
    match &result {
        Ok(_) => emit(app, engine, "done", None),
        Err(e) => {
            let msg = e.to_string();
            let kind = if msg.contains("disk space") {
                "disk"
            } else {
                crate::setup_manager::classify_pip_error(&msg).as_str()
            };
            emit(app, engine, "failed", Some((kind, msg)));
        }
    }
    result
}

fn install_locked(
    app: &AppHandle,
    engine: SttEngine,
    root: &Path,
    dir: &Path,
    expected: &str,
) -> Result<PackStatus, AppError> {
    std::fs::create_dir_all(root)
        .map_err(|e| AppError::Setup(format!("Failed to create {}: {}", root.display(), e)))?;
    let free = crate::commands_model::fs2_free_space(root);
    if free > 0 && free < MIN_PACK_FREE_BYTES {
        return Err(AppError::Setup(format!(
            "Not enough disk space for the engine pack: need {} bytes, have {}",
            MIN_PACK_FREE_BYTES, free
        )));
    }

    let partial = root.join(format!("{}.partial", engine.as_str()));
    if partial.exists() {
        std::fs::remove_dir_all(&partial)
            .map_err(|e| AppError::Setup(format!("Failed to clear {}: {}", partial.display(), e)))?;
    }
    emit(app, engine, "installing", None);

    let lock = crate::setup_manager::get_python_server_dir(app)?.join(lock_file(engine).expect("pack engine"));
    let python = crate::setup_manager::get_python_executable(app)?;
    let mut cmd = Command::new(&python);
    cmd.arg("-m").arg("pip").args(pip_args(&lock, &partial));
    for (k, v) in crate::setup_manager::build_python_env(app)? {
        // PIP_TARGET from the base env would fight --target.
        if k != "PIP_TARGET" {
            cmd.env(k, v);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Err(e) = crate::setup_manager::run_streaming_quiet(&mut cmd, app, "engine-pack") {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(e);
    }

    std::fs::write(partial.join(MARKER), expected)
        .map_err(|e| AppError::Setup(format!("Failed to write pack marker: {}", e)))?;
    if dir.exists() {
        std::fs::remove_dir_all(dir)
            .map_err(|e| AppError::Setup(format!("Failed to remove old pack: {}", e)))?;
    }
    std::fs::rename(&partial, dir)
        .map_err(|e| AppError::Setup(format!("Failed to move pack into place: {}", e)))?;
    log::info!("[engine-pack] {} installed at {}", engine.as_str(), dir.display());
    Ok(PackStatus::Ready)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("localsub-pack-test-{}", uuid_like()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn uuid_like() -> String {
        format!("{:?}{}", std::thread::current().id(), std::process::id())
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect()
    }

    #[test]
    fn only_qwen_has_a_pack() {
        assert_eq!(lock_file(SttEngine::FasterWhisper), None);
        assert_eq!(lock_file(SttEngine::Qwen3Asr), Some("requirements-qwen.lock"));
    }

    #[test]
    fn pack_lives_under_the_engine_id() {
        let root = PathBuf::from("R");
        assert_eq!(pack_dir(&root, SttEngine::Qwen3Asr), root.join("qwen3-asr"));
    }

    #[test]
    fn hash_covers_both_locks() {
        let h = inputs_hash("base", "pack");
        assert_ne!(h, inputs_hash("base2", "pack"), "a base change must reinstall the pack");
        assert_ne!(h, inputs_hash("base", "pack2"));
        assert_ne!(inputs_hash("ab", "c"), inputs_hash("a", "bc"));
    }

    #[test]
    fn status_reads_the_marker() {
        let d = tmp();
        assert_eq!(status_of(&d, None), PackStatus::NotNeeded);
        assert_eq!(status_of(&d, Some("h1")), PackStatus::Missing);
        std::fs::write(d.join(MARKER), "h1\n").unwrap();
        assert_eq!(status_of(&d, Some("h1")), PackStatus::Ready);
        assert_eq!(status_of(&d, Some("h2")), PackStatus::Stale);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pip_is_hash_locked_wheel_only_and_resolves_nothing() {
        let args = pip_args(Path::new("lock.txt"), Path::new("out"));
        for flag in ["--require-hashes", "--no-deps", "--only-binary=:all:", "--no-user"] {
            assert!(args.iter().any(|a| a == flag), "missing {flag}: {args:?}");
        }
        assert!(!args.iter().any(|a| a == "--upgrade"), "replacement is done by rename, not pip");
        let r = args.iter().position(|a| a == "-r").unwrap();
        assert_eq!(args[r + 1], "lock.txt");
        let t = args.iter().position(|a| a == "--target").unwrap();
        assert_eq!(args[t + 1], "out");
    }

    /// The bundled pack lock must be fully hash-pinned and must not pin
    /// anything the base lock pins (the pack goes on top of it, --no-deps).
    #[test]
    fn bundled_qwen_lock_is_disjoint_from_the_base_lock() {
        let base = include_str!("../../python-server/requirements.lock");
        let pack = include_str!("../../python-server/requirements-qwen.lock");
        let names = |s: &str| -> Vec<String> {
            s.lines()
                .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("--"))
                .map(|l| l.split("==").next().unwrap().to_lowercase().replace('-', "_"))
                .collect()
        };
        let base_names = names(base);
        let pack_lines: Vec<&str> = pack
            .lines()
            .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("--"))
            .collect();
        assert!(!pack_lines.is_empty());
        for line in &pack_lines {
            assert!(line.contains("--hash=sha256:"), "unhashed pack line: {line}");
        }
        for n in names(pack) {
            assert!(!base_names.contains(&n), "{n} is in both locks");
        }
        assert!(names(pack).iter().any(|n| n == "torch"));
        assert!(names(pack).iter().any(|n| n == "qwen_asr"));
    }
}
