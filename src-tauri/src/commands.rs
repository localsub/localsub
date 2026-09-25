use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands_runtime;
use crate::error::AppError;
use crate::job::Job;
use crate::python_manager;
use crate::setup_manager;
use crate::state::{RuntimeModelStatus, RuntimeStatus, ServerStatus, SetupStatus, SharedState};

/// Query free VRAM in MB via nvidia-smi. Returns None if unavailable.
/// Upper bound on waiting for a killed server's VRAM to come back.
const VRAM_RELEASE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Wait until the pinned GPU has taken back the killed server's memory.
///
/// Measured against the usage just before the kill (see gpu::vram_settled)
/// rather than an absolute "free > 6000 MB": that read nvidia-smi's answer as
/// one number, so with two GPUs it failed to parse and the wait was skipped,
/// and on a 6 GB card it could never be met, so every restart waited 20 s.
async fn wait_for_vram_release(uuid: Option<&str>, used_before: Option<u64>) {
    let (Some(uuid), Some(before)) = (uuid, used_before) else {
        // Nothing to measure (no NVIDIA GPU / no nvidia-smi). The process has
        // already exited — kill_server waits for it — so give the driver a moment.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        return;
    };
    let started = std::time::Instant::now();
    let mut prev: Option<u64> = None;
    while started.elapsed() < VRAM_RELEASE_TIMEOUT {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let Some(now) = crate::gpu::memory_used_mb(uuid) else { return };
        log::info!("VRAM in use on the pinned GPU: {} MB ({} MB before the kill)", now, before);
        if let Some(p) = prev {
            if crate::gpu::vram_settled(before, p, now, started.elapsed()) {
                return;
            }
        }
        prev = Some(now);
    }
    log::warn!("VRAM did not settle within {:?}; starting the server anyway", VRAM_RELEASE_TIMEOUT);
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

    log::info!("[setup] first-run setup starting");

    let app_clone = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        setup_manager::run_setup_sync(&app_clone)
    })
    .await
    .map_err(|e| {
        // A panic never reaches run_setup_sync's own logging.
        log::error!("[setup] setup task panicked: {}", e);
        AppError::Setup(format!("Setup task panicked: {}", e))
    })?;

    match result {
        Ok(()) => {
            log::info!("[setup] first-run setup completed");
            let mut s = state.lock().expect("Failed to lock state");
            s.setup_status = SetupStatus::COMPLETE;
            Ok(())
        }
        Err(e) => {
            // The failure otherwise only exists in the frontend's log panel,
            // which does not survive an app restart.
            log::error!("[setup] first-run setup failed: {}", e);
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
    log::info!("[setup] reset requested; wiping python-env");
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
                python_manager::replace_server_process(&mut s.server_process, child);
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
                        mark_server_failed(&mut s);
                        let _ = app_clone.emit("server-status", &s.server_status);
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

/// Roll the server state back after a failed start or restart.
///
/// Every failure path must run this. Bailing out with `server_status` still
/// STARTING pins the sidebar at "Starting..." with no further transition, and
/// leaving `model_loading = true` permanently disables the health-check crash
/// detector (`consecutive_failures >= 10 && !is_model_loading` in
/// `commands_runtime`), so `server-crashed` never fires and the frontend's
/// auto-restart never runs. `start_server` then refuses with "already running
/// or starting" and the sidebar's click-to-restart only reacts to
/// ERROR/STOPPED — every recovery path shut until the app is relaunched.
pub(crate) fn mark_server_failed(s: &mut crate::state::AppState) {
    s.server_status = ServerStatus::ERROR;
    s.model_loading = false;
    if let Some(ref mut child) = s.server_process {
        let _ = python_manager::kill_server(child);
    }
    s.server_process = None;
}

#[tauri::command]
pub async fn restart_server(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), AppError> {
    log::info!("Restarting Python server (VRAM cleanup)");
    // The release is measured on the GPU the old server was pinned to, from
    // what it held just before the kill.
    let gpu = crate::gpu::selected();
    let used_before = gpu.as_ref().and_then(|g| crate::gpu::memory_used_mb(&g.uuid));
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

    wait_for_vram_release(gpu.as_ref().map(|g| g.uuid.as_str()), used_before).await;

    {
        let mut s = state.lock().expect("Failed to lock state");
        // Spawn new server
        match python_manager::spawn_python_server(&app, port) {
            Ok(child) => python_manager::replace_server_process(&mut s.server_process, child),
            Err(e) => {
                mark_server_failed(&mut s);
                let _ = app.emit("server-status", &s.server_status);
                return Err(e);
            }
        }
    }

    // Wait for healthy (blocking — caller awaits). The failure branch has to
    // roll the state back by hand: an early `?` here returned with STARTING and
    // model_loading still set, which is the state that pins the UI forever.
    if let Err(e) = python_manager::wait_for_healthy(port).await {
        log::error!("Server restart failed: {}", e);
        {
            let mut s = state.lock().expect("Failed to lock state");
            mark_server_failed(&mut s);
            let _ = app.emit("server-status", &s.server_status);
        }
        return Err(AppError::PythonServer(format!("Server restart failed: {}", e)));
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    /// `restart_server` used to bail out with `?` while the state still said
    /// STARTING and `model_loading = true`. That combination shuts every exit:
    /// the sidebar reads "Starting..." forever, the crash detector in
    /// `commands_runtime` is gated on `!is_model_loading` so `server-crashed`
    /// never fires, and `start_server` refuses with "already running or
    /// starting". Only relaunching the app recovered.
    #[test]
    fn mark_server_failed_clears_everything_that_pins_the_ui_at_starting() {
        let mut s = AppState::default();
        s.server_status = ServerStatus::STARTING;
        s.model_loading = true;

        mark_server_failed(&mut s);

        assert_eq!(s.server_status, ServerStatus::ERROR);
        assert!(
            !s.model_loading,
            "model_loading must clear, or the crash detector stays disabled forever"
        );
        assert!(s.server_process.is_none());
    }
}
