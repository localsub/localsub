use futures::StreamExt;
use reqwest_eventsource::{Event, EventSource};
use tauri::{AppHandle, Emitter, Manager};

use crate::job::JobState;
use crate::state::SharedState;

fn update_job_progress(app: &AppHandle, job_id: &str, progress: u32, message: &str) {
    let state = app.state::<SharedState>();
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(job) = guard.jobs.get_mut(job_id) {
        job.state = JobState::RUNNING;
        job.progress = progress;
        job.message = Some(message.to_string());
        let _ = app.emit("job-updated", job.clone());
    }
}

fn update_job_done(app: &AppHandle, job_id: &str, result: &str, message: &str) {
    let state = app.state::<SharedState>();
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(job) = guard.jobs.get_mut(job_id) {
        job.state = JobState::DONE;
        job.progress = 100;
        job.result = Some(result.to_string());
        job.message = Some(message.to_string());
        let _ = app.emit("job-updated", job.clone());
    }
}

fn update_job_error(app: &AppHandle, job_id: &str, error: &str) {
    let state = app.state::<SharedState>();
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(job) = guard.jobs.get_mut(job_id) {
        job.state = JobState::FAILED;
        job.error = Some(error.to_string());
        let _ = app.emit("job-updated", job.clone());
    }
}

fn update_job_cancelled(app: &AppHandle, job_id: &str, message: &str) {
    let state = app.state::<SharedState>();
    let mut guard = match state.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(job) = guard.jobs.get_mut(job_id) {
        job.state = JobState::CANCELED;
        job.message = Some(message.to_string());
        let _ = app.emit("job-updated", job.clone());
    }
}

// ── STT stream handling ───────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct SttSegmentEvent {
    pub job_id: String,
    pub index: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

pub async fn subscribe_to_stt_stream(app: AppHandle, job_id: String, port: u16) {
    let url = format!("http://127.0.0.1:{}/stt/stream/{}", port, job_id);
    let mut es = EventSource::get(&url);

    while let Some(event) = es.next().await {
        match event {
            Ok(Event::Open) => {
                log::info!("STT SSE connection opened for job {}", job_id);
            }
            Ok(Event::Message(msg)) => {
                let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg.data);
                match parsed {
                    Ok(value) => {
                        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        let should_close =
                            handle_stt_event(&app, &job_id, event_type, &value);
                        if should_close {
                            es.close();
                            return;
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to parse STT SSE event: {}", e);
                    }
                }
            }
            Err(err) => {
                // Check if this is an intentional server restart (model switching)
                let is_model_loading = app.try_state::<SharedState>()
                    .and_then(|s| s.lock().ok().map(|s| s.model_loading))
                    .unwrap_or(false);
                if is_model_loading {
                    log::info!("STT SSE disconnected during model switch for job {}, ignoring", job_id);
                } else {
                    log::error!("STT SSE error for job {}: {}", job_id, err);
                    update_job_error(&app, &job_id, &format!("SSE connection error: {}", err));
                }
                es.close();
                return;
            }
        }
    }
}

fn handle_stt_event(
    app: &AppHandle,
    job_id: &str,
    event_type: &str,
    value: &serde_json::Value,
) -> bool {
    match event_type {
        "stt_progress" => {
            let progress = value.get("progress").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            update_job_progress(app, job_id, progress, &message);
            false
        }
        "stt_segment" => {
            let seg = SttSegmentEvent {
                job_id: job_id.to_string(),
                index: value.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                start: value.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0),
                end: value.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0),
                text: value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            };
            let _ = app.emit("stt-segment", &seg);
            false
        }
        "done" => {
            let result = value
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            update_job_done(app, job_id, &result, "Transcription complete");
            true
        }
        "error" => {
            let error = value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            update_job_error(app, job_id, &error);
            true
        }
        "cancelled" => {
            update_job_cancelled(app, job_id, "Transcription cancelled");
            true
        }
        _ => {
            log::warn!("Unknown STT event type: {}", event_type);
            false
        }
    }
}

// ── Diarization stream handling ───────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiarizationSegmentEvent {
    pub job_id: String,
    pub index: u32,
    pub speaker: String,
}

pub async fn subscribe_to_diarization_stream(app: AppHandle, job_id: String, port: u16) {
    let url = format!("http://127.0.0.1:{}/diarization/stream/{}", port, job_id);
    let mut es = EventSource::get(&url);

    while let Some(event) = es.next().await {
        match event {
            Ok(Event::Open) => {
                log::info!("Diarization SSE connection opened for job {}", job_id);
            }
            Ok(Event::Message(msg)) => {
                let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg.data);
                match parsed {
                    Ok(value) => {
                        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        let should_close =
                            handle_diarization_event(&app, &job_id, event_type, &value);
                        if should_close {
                            es.close();
                            return;
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to parse Diarization SSE event: {}", e);
                    }
                }
            }
            Err(err) => {
                log::error!("Diarization SSE error for job {}: {}", job_id, err);
                update_job_error(&app, &job_id, &format!("SSE connection error: {}", err));
                es.close();
                return;
            }
        }
    }
}

fn handle_diarization_event(
    app: &AppHandle,
    job_id: &str,
    event_type: &str,
    value: &serde_json::Value,
) -> bool {
    match event_type {
        "diar_progress" => {
            let progress = value.get("progress").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            update_job_progress(app, job_id, progress, &message);
            false
        }
        "diar_segment" => {
            let seg = DiarizationSegmentEvent {
                job_id: job_id.to_string(),
                index: value.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                speaker: value
                    .get("speaker")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            };
            let _ = app.emit("diar-segment", &seg);
            false
        }
        "done" => {
            let result = value
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            update_job_done(app, job_id, &result, "Diarization complete");
            true
        }
        "error" => {
            let error = value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            update_job_error(app, job_id, &error);
            true
        }
        "cancelled" => {
            update_job_cancelled(app, job_id, "Diarization cancelled");
            true
        }
        _ => {
            log::warn!("Unknown diarization event type: {}", event_type);
            false
        }
    }
}

// ── Translate stream handling ─────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct TranslateSegmentEvent {
    pub job_id: String,
    pub index: u32,
    pub original: String,
    pub translated: String,
}

pub async fn subscribe_to_translate_stream(app: AppHandle, job_id: String, port: u16) {
    let url = format!("http://127.0.0.1:{}/translate/stream/{}", port, job_id);
    let mut es = EventSource::get(&url);
    let mut polling_started = false;

    while let Some(event) = es.next().await {
        match event {
            Ok(Event::Open) => {
                log::info!("Translate SSE connection opened for job {}", job_id);
            }
            Ok(Event::Message(msg)) => {
                // Start resource polling on first message (LLM is now loaded and responsive)
                if !polling_started {
                    polling_started = true;
                    let needs_polling = {
                        let state = app.state::<SharedState>();
                        state.lock().map(|s| s.poll_cancel.is_none()).unwrap_or(false)
                    };
                    if needs_polling {
                        let token = crate::commands_runtime::start_resource_polling(app.clone(), port);
                        let state = app.state::<SharedState>();
                        if let Ok(mut s) = state.lock() {
                            s.poll_cancel = Some(token);
                        }
                        log::info!("Resource polling started after first translate event");
                    }
                }

                let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg.data);
                match parsed {
                    Ok(value) => {
                        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        let should_close =
                            handle_translate_event(&app, &job_id, event_type, &value);
                        if should_close {
                            es.close();
                            return;
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to parse Translate SSE event: {}", e);
                    }
                }
            }
            Err(err) => {
                let is_model_loading = app.try_state::<SharedState>()
                    .and_then(|s| s.lock().ok().map(|s| s.model_loading))
                    .unwrap_or(false);
                if is_model_loading {
                    log::info!("Translate SSE disconnected during model switch for job {}, ignoring", job_id);
                } else {
                    log::error!("Translate SSE error for job {}: {}", job_id, err);
                    update_job_error(&app, &job_id, &format!("SSE connection error: {}", err));
                }
                es.close();
                return;
            }
        }
    }
}

fn handle_translate_event(
    app: &AppHandle,
    job_id: &str,
    event_type: &str,
    value: &serde_json::Value,
) -> bool {
    match event_type {
        "translate_progress" => {
            let progress = value.get("progress").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            update_job_progress(app, job_id, progress, &message);
            false
        }
        "translate_segment" => {
            let seg = TranslateSegmentEvent {
                job_id: job_id.to_string(),
                index: value.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                original: value
                    .get("original")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                translated: value
                    .get("translated")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            };
            let _ = app.emit("translate-segment", &seg);
            false
        }
        "done" => {
            let result = value
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            update_job_done(app, job_id, &result, "Translation complete");
            true
        }
        "error" => {
            let error = value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            update_job_error(app, job_id, &error);
            true
        }
        "cancelled" => {
            update_job_cancelled(app, job_id, "Translation cancelled");
            true
        }
        _ => {
            log::warn!("Unknown translate event type: {}", event_type);
            false
        }
    }
}
