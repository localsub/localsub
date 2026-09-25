use std::path::Path;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::config_manager;
use crate::error::AppError;
use crate::job::Job;
use crate::manifest_manager;
use crate::preset_manager;
use crate::sse_client;
use crate::state::{ServerStatus, SharedState};

#[tauri::command]
pub async fn start_stt(
    app: AppHandle,
    state: State<'_, SharedState>,
    file_path: String,
    language: Option<String>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    preset_id: Option<String>,
) -> Result<Job, AppError> {
    let (port, config) = {
        let s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        if s.server_status != ServerStatus::RUNNING {
            return Err(AppError::InvalidState("Server is not running".into()));
        }
        let config = s
            .app_config
            .clone()
            .unwrap_or_else(|| config_manager::load_config().unwrap_or_default());
        (s.python_port, config)
    };

    // Wait for server to be healthy before proceeding
    let health_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    for attempt in 0..30 {
        match health_client.get(format!("http://127.0.0.1:{}/health", port)).send().await {
            Ok(resp) if resp.status().is_success() => break,
            _ => {
                if attempt == 29 {
                    return Err(AppError::PythonServer("Server not available after 30 attempts".into()));
                }
                log::info!("Waiting for server... (attempt {})", attempt + 1);
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }

    // Unload LLM to free VRAM before loading Whisper
    let unload_client = reqwest::Client::new();
    let _ = unload_client
        .post(format!("http://127.0.0.1:{}/runtime/unload", port))
        .json(&serde_json::json!({"model_type": "llm"}))
        .send()
        .await;
    log::info!("Unloaded LLM model to free VRAM for Whisper");

    // Validate file exists
    if !Path::new(&file_path).exists() {
        return Err(AppError::InvalidState(format!(
            "File not found: {}",
            file_path
        )));
    }

    // Load preset if specified
    let preset = preset_id.as_deref().and_then(|pid| {
        preset_manager::load_presets()
            .ok()
            .and_then(|presets| presets.into_iter().find(|p| p.id == pid))
    });

    // Resolve whisper model: preset.whisper_model (if non-empty and ready)
    // -> config.active_whisper_model (if ready) -> first ready.
    let manifest = manifest_manager::load_manifest(&config)?;

    let preset_whisper = preset
        .as_ref()
        .map(|p| p.whisper_model.as_str())
        .filter(|s| !s.is_empty());

    let whisper_model_id = preset_whisper
        .and_then(|id| {
            manifest
                .models
                .iter()
                .find(|m| m.id == id && m.model_type == "whisper" && m.status == "ready")
                .map(|m| m.id.clone())
        })
        .or_else(|| {
            config.active_whisper_model.as_deref().and_then(|id| {
                manifest
                    .models
                    .iter()
                    .find(|m| m.id == id && m.model_type == "whisper" && m.status == "ready")
                    .map(|m| m.id.clone())
            })
        })
        .or_else(|| {
            manifest
                .models
                .iter()
                .find(|m| m.model_type == "whisper" && m.status == "ready")
                .map(|m| m.id.clone())
        });

    log::info!(
        "STT model resolved — whisper={} (preset={})",
        whisper_model_id.as_deref().unwrap_or("<none>"),
        preset.as_ref().map(|p| p.name.as_str()).unwrap_or("<none>"),
    );

    // Build request body
    let mut body = serde_json::json!({
        "file_path": file_path,
    });
    // Use explicit language param, or fall back to config.source_language
    let effective_lang = language.or_else(|| {
        let lang = config.source_language.clone();
        if lang == "auto" { None } else { Some(lang) }
    });
    if let Some(ref lang) = effective_lang {
        body["language"] = serde_json::Value::String(lang.clone());
    }
    if let Some(ref model_id) = whisper_model_id {
        body["model_id"] = serde_json::Value::String(model_id.clone());
    }
    if let Some(st) = start_time {
        body["start_time"] = serde_json::json!(st);
    }
    if let Some(et) = end_time {
        body["end_time"] = serde_json::json!(et);
    }

    let job_id = request_stt_start(state.inner(), port, &body).await?;

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

    // Clear model_loading after delay
    {
        let app_handle = app.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            if let Some(st) = app_handle.try_state::<SharedState>() {
                if let Ok(mut s) = st.lock() {
                    s.model_loading = false;
                }
            }
        });
    }

    // Spawn SSE listener for STT stream
    let app_clone = app.clone();
    tokio::spawn(async move {
        sse_client::subscribe_to_stt_stream(app_clone, job_id, port).await;
    });

    Ok(job)
}

/// POST /stt/start with `model_loading` raised, so the health checker does not
/// mistake the model load that follows for a crash. A start that fails lowers
/// it again: nothing is loading, and a flag left up keeps the crash detector
/// muted until something else happens to clear it.
async fn request_stt_start(
    state: &SharedState,
    port: u16,
    body: &serde_json::Value,
) -> Result<String, AppError> {
    // Signal model loading (suppresses health check false alarms)
    {
        let mut s = state.lock().map_err(|e| AppError::InvalidState(format!("Lock error: {}", e)))?;
        s.model_loading = true;
    }

    let started = post_stt_start(port, body).await;
    if started.is_err() {
        if let Ok(mut s) = state.lock() {
            s.model_loading = false;
        }
    }
    started
}

async fn post_stt_start(port: u16, body: &serde_json::Value) -> Result<String, AppError> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{}/stt/start", port))
        .json(body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::PythonServer(format!(
            "STT start failed: {}",
            text
        )));
    }

    let resp_body: serde_json::Value = resp.json().await?;
    let job_id = resp_body["job_id"]
        .as_str()
        .ok_or_else(|| AppError::PythonServer("Invalid response: missing job_id".into()))?
        .to_string();
    Ok(job_id)
}

#[tauri::command]
pub async fn cancel_stt(
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
        .post(format!("http://127.0.0.1:{}/stt/cancel/{}", port, job_id))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::InvalidState("Failed to cancel STT job".into()));
    }

    // Immediately update for responsiveness
    {
        let mut s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        if let Some(job) = s.jobs.get_mut(&job_id) {
            job.state = crate::job::JobState::CANCELED;
            job.message = Some("Transcription cancelled".to_string());
            let _ = app.emit("job-updated", job.clone());
        }
    }

    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A one-shot HTTP server that answers the first request with `response`.
    async fn answer_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let _ = sock.write_all(response.as_bytes()).await;
        });
        port
    }

    fn loading(state: &SharedState) -> bool {
        state.lock().unwrap().model_loading
    }

    // model_loading mutes the crash detector. A start that failed has nothing
    // loading, and leaving the flag up kept crashes undetected until the next
    // successful STT start or server restart happened to clear it.
    #[tokio::test]
    async fn a_refused_start_lowers_model_loading() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        }; // listener dropped: connections to it are refused
        let state: SharedState = Mutex::new(AppState::default());

        let result = request_stt_start(&state, port, &serde_json::json!({})).await;

        assert!(result.is_err());
        assert!(!loading(&state), "model_loading left raised after a failed start");
    }

    #[tokio::test]
    async fn a_rejected_start_lowers_model_loading() {
        let port = answer_once(
            "HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno",
        )
        .await;
        let state: SharedState = Mutex::new(AppState::default());

        let result = request_stt_start(&state, port, &serde_json::json!({})).await;

        assert!(result.is_err());
        assert!(!loading(&state), "model_loading left raised after a failed start");
    }

    #[tokio::test]
    async fn a_started_job_keeps_model_loading_for_the_load_that_follows() {
        let port = answer_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"job_id\":\"j-1\"}",
        )
        .await;
        let state: SharedState = Mutex::new(AppState::default());

        let job_id = request_stt_start(&state, port, &serde_json::json!({})).await.unwrap();

        assert_eq!(job_id, "j-1");
        assert!(loading(&state));
    }
}
