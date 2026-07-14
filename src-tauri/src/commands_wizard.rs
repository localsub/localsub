use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::hw_detector;
use crate::state::{DiskSpace, HardwareInfo, ProfileRecommendation};

#[tauri::command]
pub async fn detect_hardware() -> Result<HardwareInfo, AppError> {
    tokio::task::spawn_blocking(hw_detector::detect_hardware)
        .await
        .map_err(|e| AppError::Hardware(format!("Task panicked: {}", e)))?
}

#[tauri::command]
pub fn recommend_profile(hw: HardwareInfo) -> ProfileRecommendation {
    hw_detector::recommend_profile(&hw)
}

#[tauri::command]
pub fn get_model_catalog(app: AppHandle) -> Result<serde_json::Value, AppError> {
    let resource_path = app
        .path()
        .resolve("model_catalog.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Config(format!("Failed to resolve catalog path: {}", e)))?;

    let data = std::fs::read_to_string(&resource_path)
        .map_err(|e| AppError::Config(format!("Failed to read model catalog: {}", e)))?;

    let catalog: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| AppError::Config(format!("Failed to parse model catalog: {}", e)))?;

    Ok(catalog)
}

#[tauri::command]
pub fn check_disk_space(path: String) -> Result<DiskSpace, AppError> {
    hw_detector::check_disk_space(&path)
}
