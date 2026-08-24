use std::fs::{File, OpenOptions};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use tauri::AppHandle;

use crate::error::AppError;
use crate::setup_manager;

/// Cap for the captured stderr before it rolls aside, keeping one `.1` backup.
const PYTHON_STDERR_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Opens the file the Python child's stderr is redirected into.
///
/// Rolls the previous contents aside first: the server is respawned on every
/// translation to reclaim VRAM, so an append-only capture would grow forever.
/// Returns None when the file cannot be opened — losing the capture must never
/// stop the server from starting.
fn open_stderr_capture(path: &Path, max_bytes: u64) -> Option<File> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    crate::utils::rotate_log_if_large(path, max_bytes);
    OpenOptions::new().create(true).append(true).open(path).ok()
}

pub fn spawn_python_server(app: &AppHandle, _port: u16) -> Result<Child, AppError> {
    // Make sure this install's bundled python312._pth points at the pip-env dir.
    // Required on every launch: a new-path install skips setup (global marker)
    // yet must still patch its own ._pth, else package imports fail. Idempotent.
    setup_manager::ensure_pth_patched(app)?;

    let python = setup_manager::get_python_executable(app)?;
    let server_dir = setup_manager::get_python_server_dir(app)?;
    let env_vars = setup_manager::build_python_env(app)?;

    let mut cmd = Command::new(&python);

    if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = src-tauri/, go up one level to project root
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let project_root = manifest_dir.parent().expect("Failed to get project root");
        let python_server_dir = project_root.join("python-server");
        cmd.arg("main.py").current_dir(&python_server_dir);
    } else {
        let main_py = server_dir.join("main.py");
        cmd.arg(&main_py);
    }

    for (k, v) in &env_vars {
        cmd.env(k, v);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Capture the child's stderr. Without this it goes nowhere: the process is
    // spawned with CREATE_NO_WINDOW and no redirection, and Python writes an
    // uncaught exception's traceback to stderr rather than through `logging`.
    // A server that dies during module import therefore left `server.log`
    // ending at "Server starting" and no record at all of what killed it.
    let stderr_path = crate::utils::log_dir().join("python-stderr.log");
    if let Some(f) = open_stderr_capture(&stderr_path, PYTHON_STDERR_MAX_BYTES) {
        cmd.stderr(Stdio::from(f));
    }
    // Uvicorn's access log goes to stdout and would bury the traceback under one
    // line per 3-second health poll. What we need to keep is on stderr.
    cmd.stdout(Stdio::null());

    let child = cmd.spawn().map_err(|e| {
        AppError::PythonServer(format!("Failed to spawn Python process: {}", e))
    })?;

    Ok(child)
}

pub async fn check_health(port: u16) -> Result<bool, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    let url = format!("http://127.0.0.1:{}/health", port);
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => Ok(true),
        _ => Ok(false),
    }
}

pub async fn wait_for_healthy(port: u16) -> Result<(), AppError> {
    let max_attempts = 60; // 30 seconds at 500ms intervals
    for _ in 0..max_attempts {
        if check_health(port).await? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(AppError::PythonServer(
        "Python server failed to start within 30 seconds".to_string(),
    ))
}

pub fn kill_server(child: &mut Child) -> Result<(), AppError> {
    kill_process_tree(child)?;
    let _ = child.wait();
    Ok(())
}

/// Kill the process and all its descendants.
/// On Windows, `child.kill()` only kills the direct process — Uvicorn workers
/// survive and keep the port open. We use `taskkill /T /F` to kill the entire
/// process tree.
#[cfg(target_os = "windows")]
fn kill_process_tree(child: &mut Child) -> Result<(), AppError> {
    let pid = child.id();
    let output = crate::utils::hidden_command("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| {
            AppError::PythonServer(format!("Failed to run taskkill: {}", e))
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!("taskkill stderr (pid {}): {}", pid, stderr);
        // Fallback to regular kill
        let _ = child.kill();
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn kill_process_tree(child: &mut Child) -> Result<(), AppError> {
    // On Unix, send SIGKILL to the process group
    child.kill().map_err(|e| {
        AppError::PythonServer(format!("Failed to kill Python process: {}", e))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("localsub_python_manager_test");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let _ = fs::remove_file(&p);
        let _ = fs::remove_file(p.with_extension("log.1"));
        p
    }

    /// The whole point of the capture file: a crashing child must leave its
    /// traceback behind. Python writes uncaught tracebacks to stderr, not
    /// through `logging`, so nothing reaches `server.log` — the fresh-PC
    /// failure showed `server.log` ending at "Server starting" with no cause.
    #[test]
    fn stderr_capture_opens_an_appendable_file() {
        let p = scratch("capture.log");

        let mut f = open_stderr_capture(&p, 1024).expect("capture file must open");
        use std::io::Write;
        f.write_all(b"Traceback (most recent call last):\n").unwrap();
        drop(f);

        assert!(fs::read_to_string(&p).unwrap().contains("Traceback"));
    }

    /// The server respawns on every translation (VRAM reclaim), so an
    /// append-only capture would grow without bound.
    #[test]
    fn stderr_capture_rolls_the_file_aside_once_it_is_too_big() {
        let p = scratch("big.log");
        fs::write(&p, vec![b'x'; 4096]).unwrap();

        let f = open_stderr_capture(&p, 1024).expect("capture file must open");
        drop(f);

        assert_eq!(fs::metadata(&p).unwrap().len(), 0, "capture should restart empty");
        assert!(p.with_extension("log.1").exists(), "previous run must be kept as .1");
    }
}
