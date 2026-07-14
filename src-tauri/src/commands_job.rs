use tauri::State;

use crate::job_manager::{self, DashboardJob};
use crate::state::SharedState;

#[tauri::command]
pub fn load_dashboard_jobs(
    _state: State<'_, SharedState>,
) -> Result<Vec<DashboardJob>, String> {
    job_manager::load_jobs().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_dashboard_jobs(
    _state: State<'_, SharedState>,
    jobs: Vec<DashboardJob>,
) -> Result<(), String> {
    job_manager::save_jobs(&jobs).map_err(|e| e.to_string())
}
