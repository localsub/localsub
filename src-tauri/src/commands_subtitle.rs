use tauri::State;
use crate::state::SharedState;
use crate::subtitle_manager::{self, SubtitleLine};

#[tauri::command]
pub fn load_job_subtitles(
    _state: State<'_, SharedState>,
    job_id: String,
) -> Result<Vec<SubtitleLine>, String> {
    subtitle_manager::load_subtitles(&job_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_job_subtitles(
    _state: State<'_, SharedState>,
    job_id: String,
    lines: Vec<SubtitleLine>,
) -> Result<(), String> {
    subtitle_manager::save_subtitles(&job_id, &lines).map_err(|e| e.to_string())
}
