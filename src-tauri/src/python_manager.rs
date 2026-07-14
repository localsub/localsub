use std::process::{Child, Command};
use std::time::Duration;

use tauri::AppHandle;

use crate::error::AppError;
use crate::setup_manager;

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
