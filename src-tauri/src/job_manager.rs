use std::fs;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::utils::{app_data_dir, atomic_write};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DashboardJob {
    pub id: String,
    pub file_name: String,
    pub file_path: String,
    pub file_size: f64,
    pub duration: f64,
    pub preset_id: String,
    pub status: String,
    pub stage: String,
    pub progress: f64,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    /// "media" (default) | "subtitle" — subtitle imports skip STT entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    /// Translated lines persisted by the last checkpoint save. Survives a
    /// restart so an interrupted translation can be resumed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translated_count: Option<u32>,
}

fn jobs_path() -> Result<std::path::PathBuf, AppError> {
    Ok(app_data_dir()?.join("jobs.json"))
}

pub fn load_jobs() -> Result<Vec<DashboardJob>, AppError> {
    let path = jobs_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)
        .map_err(|e| AppError::Config(format!("Failed to read jobs: {}", e)))?;
    let jobs: Vec<DashboardJob> = serde_json::from_str(&data)
        .map_err(|e| AppError::Config(format!("Failed to parse jobs: {}", e)))?;
    Ok(jobs)
}

pub fn save_jobs(jobs: &[DashboardJob]) -> Result<(), AppError> {
    let path = jobs_path()?;
    atomic_write(&path, jobs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dashboard_job_serialization_roundtrip() {
        let job = DashboardJob {
            id: "test-1".to_string(),
            file_name: "video.mp4".to_string(),
            file_path: "/tmp/video.mp4".to_string(),
            file_size: 1024.0,
            duration: 0.0,
            preset_id: "preset-1".to_string(),
            status: "completed".to_string(),
            stage: "done".to_string(),
            progress: 100.0,
            error: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            completed_at: Some("2026-01-01T00:05:00Z".to_string()),
            source_type: None,
            translated_count: None,
        };
        let json = serde_json::to_string(&job).unwrap();
        let restored: DashboardJob = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, "test-1");
        assert_eq!(restored.file_name, "video.mp4");
        assert_eq!(restored.status, "completed");
        assert!(restored.completed_at.is_some());
        // Absent in legacy jobs.json → defaults to None
        assert!(restored.source_type.is_none());
        assert!(restored.translated_count.is_none());
    }

    #[test]
    fn test_dashboard_job_translated_count_roundtrip() {
        let json = r#"{"id":"j2","file_name":"b.mp4","file_path":"/tmp/b.mp4","file_size":10.0,"duration":120.0,"preset_id":"p","status":"processing","stage":"translating","progress":40.0,"created_at":"2026-01-01T00:00:00Z","translated_count":75}"#;
        let job: DashboardJob = serde_json::from_str(json).unwrap();
        assert_eq!(job.translated_count, Some(75));
        let saved = serde_json::to_string(&job).unwrap();
        assert!(saved.contains("\"translated_count\":75"));
    }

    #[test]
    fn test_dashboard_job_source_type_roundtrip() {
        let json = r#"{"id":"j1","file_name":"a.srt","file_path":"/tmp/a.srt","file_size":10.0,"duration":4.0,"preset_id":"p","status":"pending","stage":"translating","progress":0.0,"created_at":"2026-01-01T00:00:00Z","source_type":"subtitle"}"#;
        let job: DashboardJob = serde_json::from_str(json).unwrap();
        assert_eq!(job.source_type.as_deref(), Some("subtitle"));
        let saved = serde_json::to_string(&job).unwrap();
        assert!(saved.contains("\"source_type\":\"subtitle\""));
    }
}
