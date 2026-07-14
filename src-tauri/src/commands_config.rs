use tauri::State;

use crate::config_manager;
use crate::error::AppError;
use crate::state::{AppConfig, PartialConfig, SharedState};

#[tauri::command]
pub fn get_config(state: State<'_, SharedState>) -> Result<AppConfig, AppError> {
    let mut s = state
        .lock()
        .map_err(|e| AppError::Config(format!("Lock error: {}", e)))?;

    if let Some(ref config) = s.app_config {
        return Ok(config.clone());
    }

    let config = config_manager::load_config()?;
    s.app_config = Some(config.clone());
    Ok(config)
}

#[tauri::command]
pub fn update_config(
    partial: PartialConfig,
    state: State<'_, SharedState>,
) -> Result<AppConfig, AppError> {
    let mut s = state
        .lock()
        .map_err(|e| AppError::Config(format!("Lock error: {}", e)))?;

    if s.app_config.is_none() {
        s.app_config = Some(config_manager::load_config()?);
    }

    let config = s
        .app_config
        .as_mut()
        .ok_or_else(|| AppError::Config("Config not initialized".to_string()))?;
    config_manager::update_config(partial, config)?;

    Ok(config.clone())
}
