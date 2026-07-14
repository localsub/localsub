use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;

#[derive(Clone, serde::Serialize)]
pub struct SetupProgress {
    pub stage: String,
    pub message: String,
    pub progress: f64,
    /// Set on failure: "network" | "disk" | "no_wheel" | "unknown".
    pub error_kind: Option<String>,
}

/// Batched live output of a setup subprocess, emitted as "setup-log".
#[derive(Clone, serde::Serialize)]
pub struct SetupLog {
    pub stage: String,
    pub lines: Vec<String>,
}

/// Coarse classification of a failed pip run, used by the frontend to show
/// an actionable message instead of raw stderr.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupErrorKind {
    Network,
    Disk,
    NoWheel,
    Integrity,
    Unknown,
}

impl SetupErrorKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            SetupErrorKind::Network => "network",
            SetupErrorKind::Disk => "disk",
            SetupErrorKind::NoWheel => "no_wheel",
            SetupErrorKind::Integrity => "integrity",
            SetupErrorKind::Unknown => "unknown",
        }
    }
}

/// Classifies pip stderr output into an actionable error kind.
/// Matching is case-insensitive.
pub fn classify_pip_error(stderr: &str) -> SetupErrorKind {
    let lower = stderr.to_lowercase();

    const NETWORK_PATTERNS: [&str; 5] = [
        "connectionerror",
        "read timed out",
        "proxyerror",
        "temporary failure",
        "getaddrinfo",
    ];
    if NETWORK_PATTERNS.iter().any(|p| lower.contains(p)) {
        return SetupErrorKind::Network;
    }

    // winerror 112 / errno 28: 비영어 Windows 로케일에서도 잡히는 코드 기반 패턴
    if lower.contains("no space left")
        || lower.contains("디스크 공간")
        || lower.contains("winerror 112")
        || lower.contains("errno 28")
    {
        return SetupErrorKind::Disk;
    }

    if lower.contains("no matching distribution") || lower.contains("could not find a version") {
        return SetupErrorKind::NoWheel;
    }

    SetupErrorKind::Unknown
}

/// Runs a setup subprocess (pip etc.) while streaming its combined
/// stdout/stderr to the frontend as batched "setup-log" events (~100ms).
///
/// On failure, stderr is classified via `classify_pip_error` and — unless
/// `emit_error_on_failure` is false (used for the CUDA attempt, which has a
/// CPU fallback and must not flash an error in the UI) — an error-kind
/// "setup-progress" event is emitted. The returned `AppError` carries the
/// last 30 stderr lines.
fn run_streaming(
    cmd: &mut Command,
    app: &AppHandle,
    stage: &str,
    emit_error_on_failure: bool,
) -> Result<(), AppError> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // 파이프 출력 시 CPython은 ~8KB 블록 버퍼링 — 실시간 스트림이 목적이므로 해제
    cmd.env("PYTHONUNBUFFERED", "1");

    let mut child = cmd.spawn().map_err(|e| {
        AppError::Setup(format!("Failed to spawn setup command ({}): {}", stage, e))
    })?;

    let buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_accum: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();

    if let Some(stdout) = child.stdout.take() {
        let buf = Arc::clone(&buffer);
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                buf.lock().unwrap().push(line);
            }
        }));
    }

    if let Some(stderr) = child.stderr.take() {
        let buf = Arc::clone(&buffer);
        let accum = Arc::clone(&stderr_accum);
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                {
                    let mut a = accum.lock().unwrap();
                    a.push_str(&line);
                    a.push('\n');
                }
                buf.lock().unwrap().push(line);
            }
        }));
    }

    let drain = |buffer: &Arc<Mutex<Vec<String>>>| {
        let lines: Vec<String> = std::mem::take(&mut *buffer.lock().unwrap());
        if !lines.is_empty() {
            let _ = app.emit(
                "setup-log",
                SetupLog {
                    stage: stage.to_string(),
                    lines,
                },
            );
        }
    };

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                drain(&buffer);
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait(); // 좀비 방지
                return Err(AppError::Setup(format!(
                    "Failed to wait for setup command ({}): {}",
                    stage, e
                )));
            }
        }
    };

    // Reader threads end once the child's pipes close; join so the final
    // drain below is guaranteed to see every line.
    for handle in readers {
        let _ = handle.join();
    }
    drain(&buffer);

    if status.success() {
        return Ok(());
    }

    let stderr = stderr_accum.lock().unwrap().clone();
    let kind = classify_pip_error(&stderr);
    let lines: Vec<&str> = stderr.lines().collect();
    let tail_start = lines.len().saturating_sub(30);
    let tail = lines[tail_start..].join("\n");
    let message = if tail.is_empty() {
        format!("Setup command failed ({}) with {}", stage, status)
    } else {
        // 어느 단계가 실패했는지 로그/토스트에서 식별 가능하게 stage 접두
        format!("[{}] {}", stage, tail)
    };

    if emit_error_on_failure {
        emit_error(app, stage, &message, kind);
    }

    Err(AppError::Setup(message))
}

/// Resolves the app's bundled resource directory, mapping the (rare) failure to
/// an AppError instead of panicking. A panic here would crash the app on first
/// launch with no error screen the user could act on. See issue #10.
fn bundled_resource_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .resource_dir()
        .map_err(|e| AppError::Setup(format!("Failed to resolve resource dir: {}", e)))
}

/// Returns the path to the Python executable.
/// In dev mode, uses system Python. In production, uses the bundled python-embed.
pub fn get_python_executable(app: &AppHandle) -> Result<PathBuf, AppError> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from("python"))
    } else {
        Ok(bundled_resource_dir(app)?.join("python-embed").join("python.exe"))
    }
}

/// Returns the path to the python-server directory.
/// In dev mode, uses the project-local python-server/. In production, uses bundled resources.
pub fn get_python_server_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    if cfg!(debug_assertions) {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        Ok(manifest_dir.parent().expect("Failed to get project root").join("python-server"))
    } else {
        Ok(bundled_resource_dir(app)?.join("python-server"))
    }
}

/// Returns the directory for installed pip packages (%APPDATA%/LocalSub/python-env/).
fn get_python_env_dir() -> PathBuf {
    let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(app_data)
        .join("LocalSub")
        .join("python-env")
}

/// Returns the path to the setup completion marker file.
fn get_marker_path() -> PathBuf {
    let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(app_data)
        .join("LocalSub")
        .join("setup-complete.marker")
}

/// Returns the default models directory (%APPDATA%/LocalSub/models/).
fn get_models_dir() -> PathBuf {
    let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(app_data)
        .join("LocalSub")
        .join("models")
}

/// Builds environment variables for running Python with bundled packages.
pub fn build_python_env(app: &AppHandle) -> Result<Vec<(String, String)>, AppError> {
    let models_dir = get_models_dir().to_string_lossy().to_string();

    if cfg!(debug_assertions) {
        return Ok(vec![
            ("MODEL_DIR".to_string(), models_dir),
            ("LOCALSUB_DEBUG".to_string(), "1".to_string()),
        ]);
    }

    let env_dir = get_python_env_dir();
    let env_dir_str = env_dir.to_string_lossy().to_string();
    let scripts_dir = env_dir.join("bin").to_string_lossy().to_string();

    let resource_dir = bundled_resource_dir(app)?;
    let python_embed_dir = resource_dir
        .join("python-embed")
        .to_string_lossy()
        .to_string();

    // The CUDA llama-cpp wheel needs cudart64_12.dll / cublas64_12.dll /
    // cublasLt64_12.dll, which it does NOT bundle. We pip-install the CUDA
    // runtime (nvidia-cuda-runtime-cu12, nvidia-cublas-cu12) into env_dir on
    // GPU machines; their DLLs land under env_dir/nvidia/*/bin. Put those on
    // PATH so the loader resolves them — this is what makes GPU translation
    // work on a machine that has only the NVIDIA driver (no CUDA Toolkit).
    // Harmless on CPU-only installs: the dirs simply don't exist.
    let cuda_runtime_bin = env_dir
        .join("nvidia")
        .join("cuda_runtime")
        .join("bin")
        .to_string_lossy()
        .to_string();
    let cublas_bin = env_dir
        .join("nvidia")
        .join("cublas")
        .join("bin")
        .to_string_lossy()
        .to_string();

    Ok(vec![
        ("PYTHONPATH".to_string(), env_dir_str.clone()),
        ("PIP_TARGET".to_string(), env_dir_str.clone()),
        ("PIP_NO_USER".to_string(), "1".to_string()),
        ("MODEL_DIR".to_string(), models_dir),
        (
            "PATH".to_string(),
            format!(
                "{};{};{};{};{}",
                python_embed_dir,
                scripts_dir,
                cuda_runtime_bin,
                cublas_bin,
                std::env::var("PATH").unwrap_or_default()
            ),
        ),
    ])
}

/// Hashes everything that decides what setup installs.
///
/// `requirements.lock` alone is not enough: the llama-cpp wheel and the CUDA
/// runtime are installed outside the lock (pinned in `integrity.json`), so a
/// wheel bump left the marker hash unchanged — setup never re-ran and the new
/// wheel never reached an existing install. Since llama-cpp is exactly what we
/// bump to fix GPU/driver/CPU-ISA crashes, that made the fix undeliverable.
fn setup_inputs_hash(requirements_lock: &str, integrity_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(requirements_lock.as_bytes());
    // Separator so ("ab", "c") and ("a", "bc") cannot hash alike.
    hasher.update(b"\x00integrity.json\x00");
    hasher.update(integrity_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Reads the two files `setup_inputs_hash` covers.
fn read_setup_inputs(app: &AppHandle) -> Result<(String, String), AppError> {
    let req_path = get_python_server_dir(app)?.join("requirements.lock");
    let req = std::fs::read_to_string(&req_path)
        .map_err(|e| AppError::Setup(format!("Failed to read requirements.lock: {}", e)))?;
    let integrity_path = crate::integrity::manifest_path(app)?;
    let integrity = std::fs::read_to_string(&integrity_path)
        .map_err(|e| AppError::Setup(format!("Failed to read integrity.json: {}", e)))?;
    Ok((req, integrity))
}

/// Checks if setup has been completed by comparing the stored marker hash with
/// the hash of the current setup inputs (requirements.lock + integrity.json).
pub fn is_setup_complete(app: &AppHandle) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }

    let marker_path = get_marker_path();
    if !marker_path.exists() {
        return false;
    }

    let (req, integrity) = match read_setup_inputs(app) {
        Ok(v) => v,
        Err(_) => return false,
    };

    let current_hash = setup_inputs_hash(&req, &integrity);
    let stored_hash = match std::fs::read_to_string(&marker_path) {
        Ok(h) => h.trim().to_string(),
        Err(_) => return false,
    };

    current_hash == stored_hash
}

/// Patches the python312._pth file to include the pip packages directory.
/// Windows embeddable Python ignores PYTHONPATH when a ._pth file exists,
/// so we must add the path directly to the ._pth file.
fn patch_pth_file(app: &AppHandle, env_dir: &std::path::Path) -> Result<(), AppError> {
    let pth_path = bundled_resource_dir(app)?
        .join("python-embed")
        .join("python312._pth");

    let content = std::fs::read_to_string(&pth_path).map_err(|e| {
        AppError::Setup(format!("Failed to read python312._pth: {}", e))
    })?;

    let env_dir_str = env_dir.to_string_lossy();
    if content.contains(env_dir_str.as_ref()) {
        return Ok(());
    }

    // Add env_dir path before "import site" line
    let patched = content.replace(
        "import site",
        &format!("{}\nimport site", env_dir_str),
    );

    std::fs::write(&pth_path, &patched).map_err(|e| {
        AppError::Setup(format!("Failed to write python312._pth: {}", e))
    })?;

    Ok(())
}

/// Ensures the bundled `python312._pth` includes the pip-env directory.
///
/// Must run on every launch before starting the server — NOT only during
/// `run_setup_sync`. `is_setup_complete` is global (marker in %APPDATA%), but
/// the `._pth` lives in the per-install bundle. A second install to a new path
/// finds the marker already present, skips setup, and would otherwise never
/// patch its own `._pth` — leaving the embeddable Python unable to import the
/// packages in %APPDATA%/LocalSub/python-env (server dies before logging).
/// Idempotent (`patch_pth_file` no-ops if already patched); no-op in dev.
pub fn ensure_pth_patched(app: &AppHandle) -> Result<(), AppError> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    patch_pth_file(app, &get_python_env_dir())
}

/// Minimum free disk space required to provision. Covers pip packages, the
/// llama-cpp wheel + CUDA runtime, and ffmpeg, with headroom. Checked before
/// any install so a nearly-full disk fails clearly instead of mid-install.
const MIN_SETUP_FREE_BYTES: u64 = 3 * 1024 * 1024 * 1024;

/// Runs the full setup process: bootstrap pip, install requirements, save marker.
/// Emits "setup-progress" events throughout the process.
pub fn run_setup_sync(app: &AppHandle) -> Result<(), AppError> {
    let python = get_python_executable(app)?;
    let server_dir = get_python_server_dir(app)?;
    let env_dir = get_python_env_dir();
    let env_vars = build_python_env(app)?;

    // Ensure env directory exists
    std::fs::create_dir_all(&env_dir).map_err(|e| {
        AppError::Setup(format!("Failed to create python-env directory: {}", e))
    })?;

    // Pre-flight disk-space check. Provisioning writes pip packages, the
    // llama-cpp wheel (the CUDA one alone unpacks a ~900 MB DLL plus the CUDA
    // runtime) and ffmpeg. Without this, a nearly-full disk fails mid-install
    // with ENOSPC — and the CUDA attempt would silently fall back to the CPU
    // wheel (smaller, so it fits), leaving a GPU user on slow CPU with no idea
    // why. Fail up front with a clear disk error instead.
    let free = crate::commands_model::fs2_free_space(&env_dir);
    if free > 0 && free < MIN_SETUP_FREE_BYTES {
        let msg = format!(
            "Not enough free disk space to install: {:.1} GB free, ~{:.0} GB required.",
            free as f64 / 1e9,
            MIN_SETUP_FREE_BYTES as f64 / 1e9,
        );
        log::error!("[setup] {}", msg);
        emit_error(app, "disk", &msg, SetupErrorKind::Disk);
        return Err(AppError::Setup(msg));
    }

    // Patch ._pth file so embedded Python can find packages in env_dir
    patch_pth_file(app, &env_dir)?;

    emit_progress(app, "pip", "Installing pip...", 0.1);

    // Step 1: Bootstrap pip using get-pip.py
    let get_pip_path = bundled_resource_dir(app)?.join("get-pip.py");

    let mut cmd = Command::new(&python);
    cmd.arg(&get_pip_path)
        .arg("--no-user")
        .arg("--target")
        .arg(&env_dir);
    for (k, v) in &env_vars {
        cmd.env(k, v);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    run_streaming(&mut cmd, app, "pip", true)?;

    emit_progress(app, "pip", "pip installed successfully", 0.3);

    // Step 2: Install requirements
    emit_progress(app, "requirements", "Installing Python packages...", 0.4);

    // Install from the hash-locked closure. --require-hashes makes pip reject
    // any package (incl. transitive) that lacks a matching sha256, so a
    // tampered or unexpected wheel fails the install instead of running.
    let req_path = server_dir.join("requirements.lock");
    let pip_exe = env_dir.join("bin").join("pip.exe");

    // Try using pip from the env bin dir, fallback to python -m pip
    let mut cmd = if pip_exe.exists() {
        let mut c = Command::new(&pip_exe);
        c.arg("install")
            .arg("--no-user")
            .arg("--require-hashes")
            .arg("-r")
            .arg(&req_path)
            .arg("--target")
            .arg(&env_dir);
        c
    } else {
        let mut c = Command::new(&python);
        c.arg("-m")
            .arg("pip")
            .arg("install")
            .arg("--no-user")
            .arg("--require-hashes")
            .arg("-r")
            .arg(&req_path)
            .arg("--target")
            .arg(&env_dir);
        c
    };

    for (k, v) in &env_vars {
        cmd.env(k, v);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    run_streaming(&mut cmd, app, "requirements", true)?;

    emit_progress(app, "requirements", "Packages installed successfully", 0.9);

    // Step 3: Install llama-cpp-python (GPU/CPU)
    emit_progress(app, "llm", "Installing LLM package...", 0.92);
    // run_setup_sync runs inside tokio::task::spawn_blocking, so block_on here
    // bridges to the async wheel-download/verify path without nesting runtimes.
    let llm_backend = tauri::async_runtime::block_on(install_llm_package(app))?;
    emit_progress(
        app,
        "llm",
        &format!("LLM package installed ({})", llm_backend),
        0.98,
    );

    // Step 3b: ffmpeg + ffprobe. Deliberately NOT fatal — see `ensure_ffmpeg`.
    if let Err(e) = ensure_ffmpeg(app) {
        log::warn!("[setup] ffmpeg install failed (non-fatal): {}", e);
        emit_progress(
            app,
            "ffmpeg",
            "FFmpeg not installed — videos over 60 minutes will not be split",
            0.99,
        );
    }

    // Step 4: Save completion marker LAST — only after every *required* install step
    // (incl. the LLM wheel) succeeded. The marker must not be written earlier:
    // `is_setup_complete` only checks marker + this hash, so a marker saved
    // before a failed LLM install would mask a broken setup as "complete" and
    // the app would skip setup on next launch. See issue #8.
    let (req_content, integrity_content) = read_setup_inputs(app)?;
    let hash = setup_inputs_hash(&req_content, &integrity_content);

    let marker_path = get_marker_path();
    if let Some(parent) = marker_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Setup(format!("Failed to create marker directory: {}", e))
        })?;
    }
    std::fs::write(&marker_path, &hash).map_err(|e| {
        AppError::Setup(format!("Failed to write setup marker: {}", e))
    })?;

    emit_progress(app, "complete", "Setup complete!", 1.0);

    Ok(())
}

/// Downloads a wheel to `env_dir`, verifies its sha256 against the manifest,
/// and returns the local path. On mismatch the partial file is removed and an
/// Integrity error is emitted. End-user machines have no compiler, so we ship
/// prebuilt wheels (abetlen's immutable GitHub release assets) and never fall
/// back to a source build.
async fn fetch_verified_wheel(
    app: &AppHandle,
    wheel: &crate::integrity::LlamaWheel,
    env_dir: &std::path::Path,
) -> Result<PathBuf, AppError> {
    let filename = wheel
        .url
        .rsplit('/')
        .next()
        .unwrap_or("llama_cpp_python.whl");
    let dest = env_dir.join(filename);

    // Tries upstream then the self-hosted mirror, verifying sha256.
    if let Err(e) = crate::integrity::download_verified(&wheel.urls(), &wheel.sha256, &dest).await {
        emit_error(app, "llm", &e.to_string(), SetupErrorKind::Integrity);
        return Err(e);
    }
    Ok(dest)
}

/// Installs ffmpeg + ffprobe unless they are already reachable (app-local or on
/// PATH).
///
/// Why in setup and not on demand: ffprobe is what decides whether a >60 min file
/// gets split into chunks, and `_probe_duration` returning None disables chunking
/// *silently* — no error, no warning the user ever sees. The only in-app install
/// prompt used to live inside the preview pane, so a user who never opened it
/// transcribed long videos in a single pass and never knew. Setup is the one
/// place every user passes through.
///
/// Why non-fatal: media under 60 minutes needs no external ffmpeg at all
/// (faster-whisper decodes via PyAV), so a failed download must not brick a first
/// run. The user can still work, and the New Job dialog offers the install again.
///
/// GPLv3: the bytes flow gyan.dev → user. Triggering that fetch from setup no more
/// makes us a distributor than a button did. Hosting a mirror would — see
/// `integrity::FfmpegEntry`.
fn ensure_ffmpeg(app: &AppHandle) -> Result<(), AppError> {
    if crate::commands_ffmpeg::check_ffmpeg()? {
        log::info!("[setup] ffmpeg and ffprobe already available; skipping download");
        return Ok(());
    }
    emit_progress(app, "ffmpeg", "Installing FFmpeg...", 0.985);
    tauri::async_runtime::block_on(crate::commands_ffmpeg::download_ffmpeg(app.clone()))?;
    log::info!("[setup] ffmpeg and ffprobe installed");
    emit_progress(app, "ffmpeg", "FFmpeg installed", 0.99);
    Ok(())
}

/// pip arguments for installing a local wheel into `env_dir`.
///
/// Deliberately NO `--upgrade`. The llama-cpp-python wheel ships top-level
/// `bin/`, `lib/`, and `include/` directories that collide with the ones pip
/// already put in `env_dir` — `bin/` in particular holds `pip.exe`. With
/// `--upgrade`, pip's `_handle_target_dir` does `shutil.rmtree(env_dir/bin)` to
/// replace it, but setup invokes pip AS `env_dir\bin\pip.exe`, so that directory
/// is in use and the delete fails with a sharing violation. pip visits `bin`
/// before `llama_cpp` (alphabetical), so the whole install aborts before
/// llama-cpp is ever written. It failed on every single upgrade attempt, and no
/// amount of retrying moved it — the lock is pip locking its own directory.
///
/// Without `--upgrade`, pip warns and SKIPS those already-present directories
/// instead of deleting them. That is fine: they are redundant. llama-cpp loads
/// its DLLs from `llama_cpp/lib/` inside the package, never the top-level
/// copies, and an install that skipped them has always worked. Replacing
/// llama-cpp itself is `purge_installed_llama`'s job — it deletes the old
/// package first, so the fresh wheel lands in an empty slot. THAT is how a
/// pinned-wheel bump reaches an existing install; `--upgrade` never was.
fn wheel_pip_args(local: &std::path::Path, env_dir: &std::path::Path) -> Vec<String> {
    vec![
        "install".to_string(),
        "--no-user".to_string(),
        "--no-deps".to_string(),
        local.to_string_lossy().into_owned(),
        "--target".to_string(),
        env_dir.to_string_lossy().into_owned(),
    ]
}

/// Removes a previously installed llama-cpp so the pinned wheel installs into a
/// clean slot. This — not pip's `--upgrade` — is how a wheel bump replaces an
/// existing install (see `wheel_pip_args` for why `--upgrade` cannot be used).
///
/// Removes the package dir and *every* `llama_cpp_python-*.dist-info`: `--target`
/// never removes the dist-info of the version it replaced (the version is in the
/// directory name), so two once sat side by side —
/// `llama_cpp_python-0.3.28.dist-info` and `-0.3.31.dist-info`.
///
/// Retries: a real-time AV scan or a lingering handle can briefly lock the
/// ~900 MB CUDA DLL. A single `remove_dir_all` would give up, the later install
/// would skip the still-present package, and the env would keep the stale wheel
/// — so back off and try again, and log loudly if it never clears.
fn purge_installed_llama(env_dir: &std::path::Path) {
    let llama = env_dir.join("llama_cpp");
    for attempt in 0..5u64 {
        if !llama.exists() || std::fs::remove_dir_all(&llama).is_ok() {
            break;
        }
        if attempt == 4 {
            log::warn!(
                "[setup] could not remove existing llama_cpp after retries; the new \
                 wheel may not replace it: {}",
                llama.display()
            );
        } else {
            std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
        }
    }
    if let Ok(entries) = std::fs::read_dir(env_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("llama_cpp_python-") && name.ends_with(".dist-info") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Installs llama-cpp-python from a pinned, hash-verified prebuilt wheel.
/// Tries the CUDA wheel when an NVIDIA GPU is present, else (or on failure)
/// the CPU wheel. Returns `"cuda"` or `"cpu"`.
pub async fn install_llm_package(app: &AppHandle) -> Result<String, AppError> {
    let env_dir = get_python_env_dir();
    let env_vars = build_python_env(app)?;
    let manifest = crate::integrity::load_integrity_manifest(app)?;
    let has_gpu = detect_nvidia_gpu();
    log::info!("[setup] NVIDIA GPU detected: {}", has_gpu);

    // (wheel, label) candidates in priority order.
    let mut attempts: Vec<(&crate::integrity::LlamaWheel, &str)> = Vec::new();
    if has_gpu {
        attempts.push((&manifest.llama_cpp.cuda, "cuda"));
    }
    attempts.push((&manifest.llama_cpp.cpu, "cpu"));

    let mut last_err: Option<AppError> = None;
    for (wheel, label) in attempts {
        let local = match fetch_verified_wheel(app, wheel, &env_dir).await {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[{}] wheel fetch/verify failed: {}", label, e);
                last_err = Some(e);
                continue;
            }
        };

        // Only now that the verified wheel is on disk — a failed download must
        // not leave the user with no llama-cpp at all.
        purge_installed_llama(&env_dir);

        // Install the local wheel; pip resolves the (pure-python) deps from
        // PyPI. No index is contacted for llama-cpp-python itself.
        let pip_exe = env_dir.join("bin").join("pip.exe");
        let mut cmd = if pip_exe.exists() {
            let mut c = Command::new(&pip_exe);
            c.args(wheel_pip_args(&local, &env_dir));
            c
        } else {
            let python = get_python_executable(app)?;
            let mut c = Command::new(&python);
            c.arg("-m").arg("pip").args(wheel_pip_args(&local, &env_dir));
            c
        };
        for (k, v) in &env_vars {
            cmd.env(k, v);
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }

        // The CUDA attempt has a CPU fallback, so don't surface its failure as
        // a hard UI error; only the final (CPU) attempt does.
        let is_last = label == "cpu";
        match run_streaming(&mut cmd, app, "llm", is_last) {
            Ok(()) => {
                let _ = std::fs::remove_file(&local);
                log::info!("[setup] installed llama-cpp wheel: {}", label);
                if label == "cuda" {
                    // The CUDA wheel won't load without the CUDA runtime DLLs it
                    // doesn't bundle. Provision them; if that fails, fall through
                    // to the CPU wheel instead of shipping a broken GPU install.
                    if let Err(e) = install_cuda_runtime(app, &env_dir) {
                        log::warn!(
                            "CUDA runtime provisioning failed, falling back to CPU: {}",
                            e
                        );
                        set_cuda_disabled(true);
                        last_err = Some(e);
                        continue;
                    }
                    // Verify GPU actually works (isolated probe). Catches an
                    // incompatible GPU/driver or a wheel that crashes on this
                    // CPU — any such failure falls back to the CPU wheel rather
                    // than shipping a GPU config that crashes the server.
                    if run_cuda_selftest(app) {
                        set_cuda_disabled(false);
                        log::info!("[setup] CUDA self-test passed; backend=cuda");
                        return Ok(label.to_string());
                    }
                    log::warn!("CUDA self-test failed; falling back to CPU wheel");
                    set_cuda_disabled(true);
                    last_err = Some(AppError::Setup("CUDA self-test failed".into()));
                    continue;
                }
                log::info!("[setup] backend=cpu");
                return Ok(label.to_string());
            }
            Err(e) => {
                let _ = std::fs::remove_file(&local);
                log::warn!("[{}] wheel install failed: {}", label, e);
                last_err = Some(e);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| AppError::Setup("LLM install failed".into())))
}

/// Installs the CUDA runtime libraries (cudart64_12.dll, cublas64_12.dll,
/// cublasLt64_12.dll) that the prebuilt CUDA llama-cpp wheel links against but
/// does not bundle. Without these, `llama.dll` fails to load on a machine that
/// has only the NVIDIA driver (no CUDA Toolkit). The DLLs install under
/// env_dir/nvidia/*/bin, which `build_python_env` adds to PATH.
///
/// Pinned to a CUDA 12.x runtime that is binary-compatible with the cu124
/// wheel (CUDA minor-version forward compatibility).
/// The CUDA runtime packages, pinned. Bumping these has the same delivery
/// problem the wheel had, so they get `--upgrade` for the same reason.
const CUDA_RUNTIME_PKGS: [&str; 2] = [
    "nvidia-cuda-runtime-cu12==12.9.79",
    "nvidia-cublas-cu12==12.9.2.10",
];

fn cuda_runtime_pip_args(env_dir: &std::path::Path) -> Vec<String> {
    let mut args = vec![
        "install".to_string(),
        "--no-user".to_string(),
        "--no-deps".to_string(),
        "--upgrade".to_string(),
    ];
    args.extend(CUDA_RUNTIME_PKGS.iter().map(|p| p.to_string()));
    args.push("--target".to_string());
    args.push(env_dir.to_string_lossy().into_owned());
    args
}

fn install_cuda_runtime(app: &AppHandle, env_dir: &std::path::Path) -> Result<(), AppError> {
    emit_progress(app, "llm", "Installing CUDA runtime...", 0.96);

    let env_vars = build_python_env(app)?;
    let pip_exe = env_dir.join("bin").join("pip.exe");
    let mut cmd = if pip_exe.exists() {
        let mut c = Command::new(&pip_exe);
        c.args(cuda_runtime_pip_args(env_dir));
        c
    } else {
        let python = get_python_executable(app)?;
        let mut c = Command::new(&python);
        c.arg("-m").arg("pip").args(cuda_runtime_pip_args(env_dir));
        c
    };
    for (k, v) in &env_vars {
        cmd.env(k, v);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    run_streaming(&mut cmd, app, "llm", true)
}

/// Path to the marker that disables GPU offload for llama-cpp. Written when the
/// CUDA self-test fails; read by python-server/gpu_utils.py.
fn get_cuda_disabled_marker_path() -> PathBuf {
    let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(app_data)
        .join("LocalSub")
        .join("cuda-disabled.marker")
}

/// Creates or removes the CUDA-disabled marker. Best-effort: a failure here only
/// affects whether we *attempt* GPU offload, and llm_engine still falls back to
/// CPU at load time, so we log and move on rather than failing setup.
fn set_cuda_disabled(disabled: bool) {
    let path = get_cuda_disabled_marker_path();
    if disabled {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&path, b"1") {
            log::warn!("Failed to write cuda-disabled marker: {}", e);
        }
    } else if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("Failed to remove cuda-disabled marker: {}", e);
        }
    }
}

/// Runs the bundled CUDA self-test in an isolated subprocess: load a tiny GGUF
/// on the GPU and run one token. Returns true only if it exits 0.
///
/// Isolated on purpose — an incompatible GPU/driver or a wheel built for the
/// wrong CPU ISA can abort the process; doing that here keeps it out of the
/// server. A hang (e.g. a wedged driver) is treated as failure after a timeout.
fn run_cuda_selftest(app: &AppHandle) -> bool {
    emit_progress(app, "llm", "Verifying GPU...", 0.97);

    let python = match get_python_executable(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("cuda self-test: cannot resolve python: {}", e);
            return false;
        }
    };
    let probe = match get_python_server_dir(app) {
        Ok(d) => d.join("cuda_selftest.py"),
        Err(e) => {
            log::warn!("cuda self-test: cannot resolve server dir: {}", e);
            return false;
        }
    };
    let model = match bundled_resource_dir(app) {
        Ok(d) => d.join("cuda_selftest.gguf"),
        Err(e) => {
            log::warn!("cuda self-test: cannot resolve resource dir: {}", e);
            return false;
        }
    };
    let env_vars = match build_python_env(app) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("cuda self-test: cannot build env: {}", e);
            return false;
        }
    };

    let mut cmd = Command::new(&python);
    cmd.arg(&probe).arg(&model);
    for (k, v) in &env_vars {
        cmd.env(k, v);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("cuda self-test: spawn failed: {}", e);
            return false;
        }
    };

    let deadline = Duration::from_secs(120);
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let ok = status.success();
                if !ok {
                    log::warn!("cuda self-test exited with failure: {}", status);
                }
                return ok;
            }
            Ok(None) => {
                if start.elapsed() > deadline {
                    log::warn!("cuda self-test timed out; treating as failure");
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => {
                log::warn!("cuda self-test: wait failed: {}", e);
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn detect_nvidia_gpu() -> bool {
    let mut cmd = Command::new("nvidia-smi");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    match cmd.output() {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

/// Removes the setup marker so setup will run again on next check.
pub fn reset_setup() -> Result<(), AppError> {
    let marker_path = get_marker_path();
    if marker_path.exists() {
        std::fs::remove_file(&marker_path).map_err(|e| {
            AppError::Setup(format!("Failed to remove setup marker: {}", e))
        })?;
    }

    let env_dir = get_python_env_dir();
    if env_dir.exists() {
        std::fs::remove_dir_all(&env_dir).map_err(|e| {
            AppError::Setup(format!("Failed to remove python-env: {}", e))
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wheel install must NOT pass `--upgrade`: the llama-cpp wheel's
    /// top-level `bin/` collides with `env_dir\bin\pip.exe`, and `--upgrade`
    /// makes pip rmtree the directory it is itself running from — a sharing
    /// violation that aborts every upgrade before llama-cpp is written.
    /// Replacement is `purge_installed_llama`'s job instead. If someone re-adds
    /// `--upgrade` to "force replacement", this fails and the doc comment
    /// explains why that is exactly backwards.
    #[test]
    fn wheel_install_does_not_use_upgrade() {
        let args = wheel_pip_args(
            std::path::Path::new(r"C:\env\llama_cpp_python-0.3.31.whl"),
            std::path::Path::new(r"C:\env"),
        );
        assert!(!args.contains(&"--upgrade".to_string()), "args: {args:?}");
        assert!(args.contains(&"--no-deps".to_string()), "args: {args:?}");
        // --target must follow the wheel path, not precede it.
        let target_idx = args.iter().position(|a| a == "--target").unwrap();
        assert_eq!(args.get(target_idx + 1).map(String::as_str), Some(r"C:\env"));
    }

    #[test]
    fn cuda_runtime_install_forces_replacement() {
        let args = cuda_runtime_pip_args(std::path::Path::new(r"C:\env"));
        assert!(args.contains(&"--upgrade".to_string()), "args: {args:?}");
        for pkg in CUDA_RUNTIME_PKGS {
            assert!(args.contains(&pkg.to_string()), "missing {pkg} in {args:?}");
        }
    }

    /// The marker used to hash only requirements.lock, which does not mention
    /// the llama-cpp wheel or ffmpeg — both pinned in integrity.json. A pin bump
    /// therefore left the hash unchanged, setup never re-ran, and the new pin
    /// never reached an existing install.
    #[test]
    fn setup_hash_changes_when_a_pin_changes() {
        let lock = "numpy==2.4.6 --hash=sha256:aaa\n";
        let integrity_a = r#"{"llama_cpp":{"cuda":{"sha256":"aaaa"}}}"#;
        let integrity_b = r#"{"llama_cpp":{"cuda":{"sha256":"bbbb"}}}"#;

        assert_eq!(
            setup_inputs_hash(lock, integrity_a),
            setup_inputs_hash(lock, integrity_a),
            "hash must be deterministic"
        );
        assert_ne!(
            setup_inputs_hash(lock, integrity_a),
            setup_inputs_hash(lock, integrity_b),
            "a changed wheel pin must invalidate the setup marker"
        );
        assert_ne!(
            setup_inputs_hash("numpy==2.4.7\n", integrity_a),
            setup_inputs_hash(lock, integrity_a),
            "a changed requirements.lock must still invalidate the marker"
        );
    }

    /// The two inputs are concatenated; without a separator, moving a byte from
    /// the end of one to the start of the other would collide.
    #[test]
    fn setup_hash_inputs_cannot_collide_by_concatenation() {
        assert_ne!(setup_inputs_hash("ab", "c"), setup_inputs_hash("a", "bc"));
    }

    /// Observed on a real install: `llama_cpp_python-0.3.28.dist-info` and
    /// `-0.3.31.dist-info` side by side, because `--target` never removes the
    /// dist-info of the version it replaced (the version is in the directory
    /// name). Purge both, and nothing else.
    #[test]
    fn purge_removes_package_and_every_stale_dist_info() {
        let dir = std::env::temp_dir().join(format!("localsub_purge_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in [
            "llama_cpp",
            "llama_cpp_python-0.3.28.dist-info",
            "llama_cpp_python-0.3.31.dist-info",
            "numpy",                 // must survive
            "nvidia",                // must survive
            "llama_cpp_helper",      // similar prefix, not a dist-info: must survive
        ] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }

        purge_installed_llama(&dir);

        assert!(!dir.join("llama_cpp").exists());
        assert!(!dir.join("llama_cpp_python-0.3.28.dist-info").exists());
        assert!(!dir.join("llama_cpp_python-0.3.31.dist-info").exists());
        assert!(dir.join("numpy").exists(), "unrelated package removed");
        assert!(dir.join("nvidia").exists(), "cuda runtime removed");
        assert!(dir.join("llama_cpp_helper").exists(), "prefix match over-reached");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn classify_network_errors() {
        let cases = [
            "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='pypi.org', port=443)",
            "urllib3.exceptions.ReadTimeoutError: Read timed out.",
            "ProxyError('Cannot connect to proxy.')",
            "Temporary failure in name resolution",
            "socket.gaierror: [Errno 11001] getaddrinfo failed",
        ];
        for stderr in cases {
            assert_eq!(
                classify_pip_error(stderr),
                SetupErrorKind::Network,
                "should classify as Network: {}",
                stderr
            );
        }
    }

    #[test]
    fn classify_disk_errors() {
        assert_eq!(
            classify_pip_error("OSError: [Errno 28] No space left on device"),
            SetupErrorKind::Disk
        );
        assert_eq!(
            classify_pip_error("오류: 디스크 공간이 부족합니다"),
            SetupErrorKind::Disk
        );
    }

    #[test]
    fn classify_no_wheel_errors() {
        assert_eq!(
            classify_pip_error("ERROR: No matching distribution found for llama-cpp-python==0.3.28"),
            SetupErrorKind::NoWheel
        );
        assert_eq!(
            classify_pip_error(
                "ERROR: Could not find a version that satisfies the requirement llama-cpp-python"
            ),
            SetupErrorKind::NoWheel
        );
    }

    #[test]
    fn classify_unknown_errors() {
        assert_eq!(classify_pip_error(""), SetupErrorKind::Unknown);
        assert_eq!(
            classify_pip_error("Traceback (most recent call last):\nValueError: oops"),
            SetupErrorKind::Unknown
        );
    }

    #[test]
    fn classify_is_case_insensitive() {
        assert_eq!(classify_pip_error("CONNECTIONERROR"), SetupErrorKind::Network);
        assert_eq!(classify_pip_error("READ TIMED OUT"), SetupErrorKind::Network);
        assert_eq!(
            classify_pip_error("no matching distribution found"),
            SetupErrorKind::NoWheel
        );
        assert_eq!(classify_pip_error("NO SPACE LEFT on device"), SetupErrorKind::Disk);
    }

    #[test]
    fn classify_error_kind_as_str() {
        assert_eq!(SetupErrorKind::Network.as_str(), "network");
        assert_eq!(SetupErrorKind::Disk.as_str(), "disk");
        assert_eq!(SetupErrorKind::NoWheel.as_str(), "no_wheel");
        assert_eq!(SetupErrorKind::Unknown.as_str(), "unknown");
    }

    #[test]
    fn integrity_kind_as_str() {
        assert_eq!(SetupErrorKind::Integrity.as_str(), "integrity");
    }
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, progress: f64) {
    let _ = app.emit(
        "setup-progress",
        SetupProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            progress,
            error_kind: None,
        },
    );
}

/// Emits a setup-progress event carrying a classified error kind.
/// The frontend treats the presence of `error_kind` as a failure signal,
/// so `progress` is left at 0.0.
fn emit_error(app: &AppHandle, stage: &str, message: &str, kind: SetupErrorKind) {
    let _ = app.emit(
        "setup-progress",
        SetupProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            progress: 0.0,
            error_kind: Some(kind.as_str().to_string()),
        },
    );
}
