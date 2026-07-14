use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands_runtime;
use crate::error::AppError;
use crate::job::Job;
use crate::python_manager;
use crate::setup_manager;
use crate::state::{RuntimeModelStatus, RuntimeStatus, ServerStatus, SetupStatus, SharedState};

/// Query free VRAM in MB via nvidia-smi. Returns None if unavailable.
fn get_vram_free_mb() -> Option<u64> {
    let output = crate::utils::hidden_command("nvidia-smi")
        .args(["--query-gpu=memory.free", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse::<u64>().ok()
}

#[tauri::command]
pub async fn check_setup(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<SetupStatus, AppError> {
    let complete = setup_manager::is_setup_complete(&app);
    let status = if complete {
        SetupStatus::COMPLETE
    } else {
        SetupStatus::NEEDED
    };

    {
        let mut s = state.lock().expect("Failed to lock state");
        s.setup_status = status.clone();
    }

    Ok(status)
}

#[tauri::command]
pub async fn run_setup(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), AppError> {
    {
        let mut s = state.lock().expect("Failed to lock state");
        s.setup_status = SetupStatus::IN_PROGRESS;
    }

    let app_clone = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        setup_manager::run_setup_sync(&app_clone)
    })
    .await
    .map_err(|e| AppError::Setup(format!("Setup task panicked: {}", e)))?;

    match result {
        Ok(()) => {
            let mut s = state.lock().expect("Failed to lock state");
            s.setup_status = SetupStatus::COMPLETE;
            Ok(())
        }
        Err(e) => {
            let mut s = state.lock().expect("Failed to lock state");
            s.setup_status = SetupStatus::ERROR;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn reset_setup(
    state: State<'_, SharedState>,
) -> Result<(), AppError> {
    setup_manager::reset_setup()?;
    let mut s = state.lock().expect("Failed to lock state");
    s.setup_status = SetupStatus::NEEDED;
    Ok(())
}

#[tauri::command]
pub async fn start_server(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), AppError> {
    // Gate: check setup in production. Read the on-disk marker via
    // is_setup_complete rather than the in-memory setup_status, which the
    // frontend sets asynchronously (check_setup). On launch the auto-start
    // effect can fire before check_setup has synced the flag — that race left
    // the server un-started on new-path installs (setup already complete on
    // disk, but the in-memory flag not yet COMPLETE).
    if !cfg!(debug_assertions) && !setup_manager::is_setup_complete(&app) {
        return Err(AppError::InvalidState(
            "Setup must be completed before starting the server".into(),
        ));
    }

    {
        let mut s = state.lock().expect("Failed to lock state");
        if s.server_status == ServerStatus::RUNNING || s.server_status == ServerStatus::STARTING {
            return Err(AppError::InvalidState("Server is already running or starting".into()));
        }
        s.server_status = ServerStatus::STARTING;
        let _ = app.emit("server-status", &s.server_status);
    }

    let port;
    {
        let mut s = state.lock().expect("Failed to lock state");
        port = s.python_port;

        match python_manager::spawn_python_server(&app, port) {
            Ok(child) => {
                s.server_process = Some(child);
            }
            Err(e) => {
                s.server_status = ServerStatus::ERROR;
                let _ = app.emit("server-status", &s.server_status);
                return Err(e);
            }
        }
    }

    // Wait for healthy in background
    let app_clone = app.clone();
    tokio::spawn(async move {
        let state = app_clone.state::<SharedState>();
        match python_manager::wait_for_healthy(port).await {
            Ok(()) => {
                // Start resource polling
                let token = commands_runtime::start_resource_polling(app_clone.clone(), port);
                match state.lock() {
                    Ok(mut s) => {
                        s.poll_cancel = Some(token);
                        s.server_status = ServerStatus::RUNNING;
                        let _ = app_clone.emit("server-status", &s.server_status);
                    }
                    Err(e) => {
                        log::error!("Failed to lock state after health check success: {}", e);
                    }
                }
            }
            Err(e) => {
                log::error!("Server health check failed: {}", e);
                match state.lock() {
                    Ok(mut s) => {
                        s.server_status = ServerStatus::ERROR;
                        let _ = app_clone.emit("server-status", &s.server_status);
                        // Kill the process if health check fails
                        if let Some(ref mut child) = s.server_process {
                            let _ = python_manager::kill_server(child);
                        }
                        s.server_process = None;
                    }
                    Err(e2) => {
                        log::error!("Failed to lock state after health check failure: {}", e2);
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn restart_server(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), AppError> {
    log::info!("Restarting Python server (VRAM cleanup)");
    let port;
    {
        let mut s = state.lock().expect("Failed to lock state");
        // Cancel existing polling
        if let Some(token) = s.poll_cancel.take() {
            token.cancel();
        }
        // Kill old server
        if let Some(ref mut child) = s.server_process {
            let _ = python_manager::kill_server(child);
        }
        s.server_process = None;
        s.server_status = ServerStatus::STARTING;
        s.model_loading = true;
        let _ = app.emit("server-status", &s.server_status);
        port = s.python_port;
    }

    // Wait for CUDA VRAM to be released after process kill
    for attempt in 0..20 {
        let vram_free = get_vram_free_mb();
        if let Some(free) = vram_free {
            log::info!("VRAM free: {} MB (attempt {})", free, attempt + 1);
            // Need at least 6000 MB free for LLM (9B Q4 model)
            if free > 6000 {
                break;
            }
        } else {
            // nvidia-smi not available, just wait a fixed time
            if attempt >= 3 {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    {
        let mut s = state.lock().expect("Failed to lock state");
        // Spawn new server
        match python_manager::spawn_python_server(&app, port) {
            Ok(child) => { s.server_process = Some(child); }
            Err(e) => {
                s.server_status = ServerStatus::ERROR;
                let _ = app.emit("server-status", &s.server_status);
                return Err(e);
            }
        }
    }

    // Wait for healthy (blocking — caller awaits)
    python_manager::wait_for_healthy(port).await.map_err(|e| {
        AppError::PythonServer(format!("Server restart failed: {}", e))
    })?;

    {
        let mut s = state.lock().expect("Failed to lock state");
        s.server_status = ServerStatus::RUNNING;
        s.model_loading = false;
        let _ = app.emit("server-status", &s.server_status);
        // Don't start polling yet — LLM loading will block GIL and cause false health failures.
        // Polling will be started by the translate SSE handler after the first event arrives.
    }

    log::info!("Python server restarted successfully (polling deferred)");
    Ok(())
}

#[tauri::command]
pub async fn stop_server(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), AppError> {
    let mut s = state.lock().expect("Failed to lock state");

    // Cancel resource polling
    if let Some(token) = s.poll_cancel.take() {
        token.cancel();
    }

    if let Some(ref mut child) = s.server_process {
        python_manager::kill_server(child)?;
    }
    s.server_process = None;
    s.server_status = ServerStatus::STOPPED;
    let _ = app.emit("server-status", &s.server_status);

    // Reset runtime status
    s.runtime_status = RuntimeStatus {
        whisper: RuntimeModelStatus::UNLOADED,
        llm: RuntimeModelStatus::UNLOADED,
    };
    let _ = app.emit("runtime-status", &s.runtime_status);

    Ok(())
}

#[tauri::command]
pub async fn get_server_status(
    state: State<'_, SharedState>,
) -> Result<ServerStatus, AppError> {
    let s = state.lock().expect("Failed to lock state");
    Ok(s.server_status.clone())
}

#[tauri::command]
pub async fn get_jobs(
    state: State<'_, SharedState>,
) -> Result<Vec<Job>, AppError> {
    let s = state.lock().expect("Failed to lock state");
    let mut jobs: Vec<Job> = s.jobs.values().cloned().collect();
    jobs.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(jobs)
}
