use crate::state::Vocabulary;
use crate::vocabulary_manager;
use crate::error::AppError;

#[tauri::command]
pub fn get_vocabularies() -> Result<Vec<Vocabulary>, AppError> {
    vocabulary_manager::load_vocabularies()
}

#[tauri::command]
pub fn add_vocabulary(vocabulary: Vocabulary) -> Result<Vec<Vocabulary>, AppError> {
    vocabulary_manager::add_vocabulary(vocabulary)
}

#[tauri::command]
pub fn update_vocabulary(vocabulary: Vocabulary) -> Result<Vec<Vocabulary>, AppError> {
    vocabulary_manager::update_vocabulary(vocabulary)
}

#[tauri::command]
pub fn remove_vocabulary(id: String) -> Result<Vec<Vocabulary>, AppError> {
    vocabulary_manager::remove_vocabulary(&id)
}
