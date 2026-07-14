use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use crate::error::AppError;
use crate::utils;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleLine {
    pub id: String,
    pub index: u32,
    pub start_time: f64,
    pub end_time: f64,
    pub original_text: String,
    pub translated_text: String,
    #[serde(default)]
    pub speaker: Option<String>,
    pub status: String,
}

fn subtitles_dir() -> Result<PathBuf, AppError> {
    Ok(utils::app_data_dir()?.join("subtitles"))
}

pub fn load_subtitles(job_id: &str) -> Result<Vec<SubtitleLine>, AppError> {
    let dir = subtitles_dir()?;
    let path = dir.join(format!("{}.json", job_id));
    if path.exists() {
        let data = fs::read_to_string(&path)
            .map_err(|e| AppError::Config(format!("Failed to read subtitles: {}", e)))?;
        let lines: Vec<SubtitleLine> = serde_json::from_str(&data)
            .map_err(|e| AppError::Config(format!("Failed to parse subtitles: {}", e)))?;
        Ok(lines)
    } else {
        Ok(Vec::new())
    }
}

pub fn save_subtitles(job_id: &str, lines: &[SubtitleLine]) -> Result<(), AppError> {
    let dir = subtitles_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::Config(format!("Failed to create subtitles dir: {}", e)))?;
    let path = dir.join(format!("{}.json", job_id));
    utils::atomic_write(&path, lines)
}
