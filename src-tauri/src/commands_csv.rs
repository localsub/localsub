use crate::csv_reader::{parse_csv, CsvRow};
use crate::error::AppError;

#[tauri::command]
pub fn read_csv_file(path: String) -> Result<Vec<CsvRow>, AppError> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Io(e))?;
    Ok(parse_csv(&content))
}
