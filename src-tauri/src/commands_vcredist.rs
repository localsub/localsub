//! Tauri commands for the Visual C++ runtime.
//!
//! Kept out of the setup flow on purpose. Setup runs once and is remembered by
//! a marker; the runtime is machine state that can change underneath us, so it
//! is probed on demand and the install can be started from anywhere in the UI.
//! That is what makes a declined elevation prompt recoverable.

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::state::SharedState;
use crate::vcredist::{self, Attempt, Outcome, RuntimeStatus};

/// Everything the UI needs to decide what to show: what is missing now, and
/// what happened the last time someone tried to fix it.
#[derive(Debug, Clone, Serialize)]
pub struct VcRedistState {
    pub status: RuntimeStatus,
    pub last_attempt: Option<Attempt>,
}

/// Probes the runtime and returns it alongside the last attempt record.
///
/// Cheap by design so the frontend can call it on mount and after every
/// install, rather than caching a verdict that may already be stale.
#[tauri::command]
pub fn get_vcredist_state() -> VcRedistState {
    VcRedistState {
        status: vcredist::status(),
        last_attempt: vcredist::read_attempt(),
    }
}

/// Downloads and installs the Visual C++ runtime.
///
/// Returns `Outcome::Declined` rather than an error when the user dismisses the
/// Windows elevation prompt: the caller should offer the button again, not
/// report a failure.
#[tauri::command]
pub async fn install_vcredist(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<Outcome, AppError> {
    let cancel = CancellationToken::new();
    {
        let mut s = state.lock().expect("Failed to lock state");
        if s.vcredist_cancel.is_some() {
            return Err(AppError::InvalidState(
                "A runtime install is already running".into(),
            ));
        }
        s.vcredist_cancel = Some(cancel.clone());
    }

    let result = vcredist::install(&app, cancel).await;

    // Cleared on every path, or a failed attempt would lock out every retry
    // with "already running" -- the exact dead end this feature exists to
    // remove.
    {
        let mut s = state.lock().expect("Failed to lock state");
        s.vcredist_cancel = None;
    }

    result
}

/// Cancels an in-progress install.
///
/// Only the download can actually be interrupted. Once Microsoft's installer
/// has been launched it owns the screen, and the elevation prompt is dismissed
/// by the user, not by us -- which surfaces as `Outcome::Declined`.
#[tauri::command]
pub fn cancel_vcredist_install(state: State<'_, SharedState>) -> Result<(), AppError> {
    let mut s = state.lock().expect("Failed to lock state");
    if let Some(token) = s.vcredist_cancel.take() {
        token.cancel();
        log::info!("[vcredist] install cancelled by user");
    }
    Ok(())
}
