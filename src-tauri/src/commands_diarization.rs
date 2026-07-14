use std::path::Path;

use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::job::Job;
use crate::sse_client;
use crate::state::{ServerStatus, SharedState};

#[derive(serde::Deserialize)]
pub struct DiarSegmentInput {
    pub index: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[tauri::command]
pub async fn start_diarization(
    app: AppHandle,
    state: State<'_, SharedState>,
    file_path: String,
    segments: Vec<DiarSegmentInput>,
) -> Result<Job, AppError> {
    let port = {
        let s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        if s.server_status != ServerStatus::RUNNING {
            return Err(AppError::InvalidState("Server is not running".into()));
        }
        s.python_port
    };

    // Validate file exists
    if !Path::new(&file_path).exists() {
        return Err(AppError::InvalidState(format!(
            "File not found: {}",
            file_path
        )));
    }

    // Build request body
    let segments_json: Vec<serde_json::Value> = segments
        .iter()
        .map(|s| {
            serde_json::json!({
                "index": s.index,
                "start": s.start,
                "end": s.end,
                "text": s.text,
            })
        })
        .collect();

    let body = serde_json::json!({
        "file_path": file_path,
        "segments": segments_json,
    });

    // POST /diarization/start
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{}/diarization/start", port))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::PythonServer(format!(
            "Diarization start failed: {}",
            text
        )));
    }

    let resp_body: serde_json::Value = resp.json().await?;
    let job_id = resp_body["job_id"]
        .as_str()
        .ok_or_else(|| AppError::PythonServer("Invalid response: missing job_id".into()))?
        .to_string();

    let job = Job::new(job_id.clone(), file_path);

    // Store job
    {
        let mut s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        s.jobs.insert(job_id.clone(), job.clone());
    }

    // Emit initial job state
    let _ = app.emit("job-updated", &job);

    // Spawn SSE listener for diarization stream
    let app_clone = app.clone();
    tokio::spawn(async move {
        sse_client::subscribe_to_diarization_stream(app_clone, job_id, port).await;
    });

    Ok(job)
}

#[tauri::command]
pub async fn cancel_diarization(
    app: AppHandle,
    state: State<'_, SharedState>,
    job_id: String,
) -> Result<(), AppError> {
    let port = {
        let s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        if !s.jobs.contains_key(&job_id) {
            return Err(AppError::JobNotFound(job_id));
        }
        s.python_port
    };

    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "http://127.0.0.1:{}/diarization/cancel/{}",
            port, job_id
        ))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::InvalidState(
            "Failed to cancel diarization job".into(),
        ));
    }

    // Immediately update for responsiveness
    {
        let mut s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        if let Some(job) = s.jobs.get_mut(&job_id) {
            job.state = crate::job::JobState::CANCELED;
            job.message = Some("Diarization cancelled".to_string());
            let _ = app.emit("job-updated", job.clone());
        }
    }

    Ok(())
}
