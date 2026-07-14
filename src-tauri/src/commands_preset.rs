use crate::state::Preset;
use crate::preset_manager;
use crate::error::AppError;

#[tauri::command]
pub fn get_presets() -> Result<Vec<Preset>, AppError> {
    preset_manager::load_presets()
}

#[tauri::command]
pub fn add_preset(preset: Preset) -> Result<Vec<Preset>, AppError> {
    preset_manager::add_preset(preset)
}

#[tauri::command]
pub fn update_preset(preset: Preset) -> Result<Vec<Preset>, AppError> {
    preset_manager::update_preset(preset)
}

#[tauri::command]
pub fn remove_preset(id: String) -> Result<Vec<Preset>, AppError> {
    preset_manager::remove_preset(&id)
}
