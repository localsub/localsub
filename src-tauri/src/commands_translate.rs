use tauri::{AppHandle, Emitter, State};

use crate::commands_model;
use crate::config_manager;
use crate::contracts::SubtitleSegment;
use crate::error::AppError;
use crate::job::Job;
use crate::manifest_manager;
use crate::preset_manager;
use crate::sse_client;
use crate::state::{GlossaryEntry, ServerStatus, SharedState};
use crate::vocabulary_manager;

// ── Preset/config field resolution ──
// When a preset is active, its field wins if non-empty.
// Otherwise fall back to the equivalent config field.

fn resolve_str<'a>(preset_val: Option<&'a str>, config_val: &'a str) -> &'a str {
    match preset_val {
        Some(s) if !s.trim().is_empty() => s,
        _ => config_val,
    }
}

fn resolve_opt_str(preset_val: Option<&str>, config_val: Option<&str>) -> Option<String> {
    match preset_val {
        Some(s) if !s.trim().is_empty() => Some(s.to_string()),
        _ => config_val.filter(|s| !s.trim().is_empty()).map(str::to_string),
    }
}

#[tauri::command]
pub async fn start_translate(
    app: AppHandle,
    state: State<'_, SharedState>,
    segments: Vec<SubtitleSegment>,
    preset_id: Option<String>,
) -> Result<Job, AppError> {
    let (port, config) = {
        let s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        if s.server_status == ServerStatus::STOPPED || s.server_status == ServerStatus::ERROR {
            return Err(AppError::InvalidState("Server is not running".into()));
        }
        let config = s
            .app_config
            .clone()
            .unwrap_or_else(|| config_manager::load_config().unwrap_or_default());
        (s.python_port, config)
    };

    // Load preset if specified — override config with preset values
    let preset = preset_id.as_deref().and_then(|pid| {
        preset_manager::load_presets()
            .ok()
            .and_then(|presets| presets.into_iter().find(|p| p.id == pid))
    });

    // Check translation mode
    if config.translation_mode == "off" {
        return Err(AppError::InvalidState("Translation mode is off".into()));
    }

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

    // Note: Server restart for VRAM cleanup is handled by frontend (usePipeline)
    // Frontend stops server, starts fresh, then calls startTranslate

    // Glossary comes from `preset.vocabulary_id` and nowhere else — the legacy
    // file-backed `active_glossary` path is gone. No preset, or a preset with no
    // vocabulary attached, means nothing is injected.
    let glossary: Vec<GlossaryEntry> = if let Some(ref p) = preset {
        if let Some(ref vocab_id) = p.vocabulary_id {
            match vocabulary_manager::load_vocabularies() {
                Ok(vocabs) => {
                    if let Some(vocab) = vocabs.into_iter().find(|v| v.id == *vocab_id) {
                        log::info!(
                            "Loaded vocabulary '{}' ({} entries) from preset '{}'",
                            vocab.name,
                            vocab.entries.len(),
                            p.name
                        );
                        vocab
                            .entries
                            .into_iter()
                            .map(|e| GlossaryEntry {
                                source: e.source,
                                target: e.target,
                            })
                            .collect()
                    } else {
                        log::warn!("Vocabulary id '{}' not found (preset '{}')", vocab_id, p.name);
                        vec![]
                    }
                }
                Err(e) => {
                    log::warn!("Failed to list vocabularies: {}", e);
                    vec![]
                }
            }
        } else {
            // Preset selected but no vocabulary attached — nothing to inject.
            vec![]
        }
    } else {
        // No preset selected — nothing to inject.
        vec![]
    };

    // Find a ready LLM model: preset.llm_model wins when set and ready; else config.active_llm_model; else first ready.
    let manifest = manifest_manager::load_manifest(&config)?;

    let preset_llm = preset
        .as_ref()
        .map(|p| p.llm_model.as_str())
        .filter(|s| !s.is_empty());

    let llm_model_id = preset_llm
        .and_then(|id| {
            manifest
                .models
                .iter()
                .find(|m| m.id == id && m.model_type == "llm" && m.status == "ready")
                .map(|m| m.id.clone())
        })
        .or_else(|| {
            config.active_llm_model.as_deref().and_then(|id| {
                manifest
                    .models
                    .iter()
                    .find(|m| m.id == id && m.model_type == "llm" && m.status == "ready")
                    .map(|m| m.id.clone())
            })
        })
        .or_else(|| {
            manifest
                .models
                .iter()
                .find(|m| m.model_type == "llm" && m.status == "ready")
                .map(|m| m.id.clone())
        });

    // No ready LLM model anywhere. Sending a translate request with no model_id
    // makes the Python server fail opaquely; fail fast with a clear message.
    // (The frontend normally catches this earlier and finalizes STT-only.)
    if llm_model_id.is_none() {
        return Err(AppError::InvalidState(
            "No translation LLM model is installed. Install one, or run STT-only.".into(),
        ));
    }

    // Look up n_gpu_layers_default and model_category from catalog for the selected model
    let catalog_opt = commands_model::load_catalog(&app).ok();
    let catalog_entry = llm_model_id.as_ref().and_then(|model_id| {
        catalog_opt.as_ref().and_then(|catalog| {
            catalog
                .llm_models
                .iter()
                .find(|m| m.id == *model_id)
        })
    });
    let n_gpu_layers: Option<i32> = catalog_entry.map(|m| m.n_gpu_layers_default);
    // "general" makes the prompt builder inject `/no_think`, a Qwen3-only directive that
    // leaks as junk tokens elsewhere. A model missing from the catalog (delisted, but still
    // installed) must not opt into it, so the fallback is the inert category.
    let model_category = catalog_entry
        .and_then(|m| m.model_category.clone())
        .unwrap_or_else(|| "instruct".to_string());

    // Build segment payload for Python
    let segment_payload: Vec<serde_json::Value> = segments
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

    // Build glossary payload
    let glossary_payload: Vec<serde_json::Value> = glossary
        .iter()
        .map(|g| {
            serde_json::json!({
                "source": g.source,
                "target": g.target,
            })
        })
        .collect();

    // Resolve per-field: preset wins when set, config fills in otherwise.
    let p_source_lang = preset.as_ref().map(|p| p.source_lang.as_str());
    let p_target_lang = preset.as_ref().map(|p| p.target_lang.as_str());
    let p_style = preset.as_ref().map(|p| p.translation_style.as_str());

    let resolved_source_lang = resolve_str(p_source_lang, &config.source_language).to_string();
    let resolved_target_lang = resolve_str(p_target_lang, &config.target_language).to_string();
    let resolved_style = resolve_str(p_style, &config.style_preset).to_string();

    // Build request body
    let mut body = serde_json::json!({
        "segments": segment_payload,
        "source_lang": resolved_source_lang,
        "target_lang": resolved_target_lang,
        "context_window": config.context_window,
        "style_preset": resolved_style,
        "glossary": glossary_payload,
    });
    if let Some(ref model_id) = llm_model_id {
        body["model_id"] = serde_json::Value::String(model_id.clone());
    }
    if let Some(layers) = n_gpu_layers {
        body["n_gpu_layers"] = serde_json::json!(layers);
    }

    // Translation quality / custom prompt / two-pass — preset wins when set.
    let resolved_quality = resolve_opt_str(
        preset.as_ref().and_then(|p| p.translation_quality.as_deref()),
        config.translation_quality.as_deref(),
    )
    .unwrap_or_else(|| "balanced".to_string());
    body["translation_quality"] = serde_json::json!(resolved_quality);

    let resolved_custom_prompt = resolve_opt_str(
        preset.as_ref().and_then(|p| p.custom_translation_prompt.as_deref()),
        config.custom_translation_prompt.as_deref(),
    );
    if let Some(ref prompt) = resolved_custom_prompt {
        body["custom_prompt"] = serde_json::json!(prompt);
    }

    // ── Pivot 2-pass resolution ─────────────────────────────────
    // translation_mode is a string so we can add more modes later
    // ("pivot_2pass_mt", "dual_model", …) without another migration.
    let resolved_mode = preset
        .as_ref()
        .and_then(|p| p.translation_mode.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "direct".to_string());
    body["translation_mode"] = serde_json::json!(resolved_mode);

    let resolved_pivot_language = preset
        .as_ref()
        .and_then(|p| p.pivot_language.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "en".to_string());

    // Load pivot vocabulary only when pivot mode is active and a vocab is set.
    let pivot_glossary: Vec<GlossaryEntry> = if resolved_mode == "pivot_2pass" {
        let pivot_id = preset.as_ref().and_then(|p| p.pivot_vocabulary_id.clone());
        match pivot_id {
            Some(id) if !id.trim().is_empty() => {
                match vocabulary_manager::load_vocabularies() {
                    Ok(vocabs) => {
                        if let Some(v) = vocabs.into_iter().find(|v| v.id == id) {
                            log::info!(
                                "Loaded pivot vocabulary '{}' ({} entries)",
                                v.name, v.entries.len()
                            );
                            v.entries
                                .into_iter()
                                .map(|e| GlossaryEntry {
                                    source: e.source,
                                    target: e.target,
                                })
                                .collect()
                        } else {
                            log::warn!("Pivot vocabulary id '{}' not found", id);
                            vec![]
                        }
                    }
                    Err(e) => {
                        log::warn!("Failed to list vocabularies for pivot: {}", e);
                        vec![]
                    }
                }
            }
            _ => vec![],
        }
    } else {
        vec![]
    };

    let pivot_glossary_payload: Vec<serde_json::Value> = pivot_glossary
        .iter()
        .map(|g| serde_json::json!({ "source": g.source, "target": g.target }))
        .collect();

    body["pivot_language"] = serde_json::json!(resolved_pivot_language);
    body["pivot_glossary"] = serde_json::json!(pivot_glossary_payload);

    log::info!(
        "Translation config resolved — lang={}→{}, style={}, quality={}, mode={}, pivot_lang={}, pivot_vocab_entries={}, custom_prompt={}, llm={} (preset={})",
        resolved_source_lang,
        resolved_target_lang,
        resolved_style,
        resolved_quality,
        resolved_mode,
        if resolved_mode == "pivot_2pass" { resolved_pivot_language.as_str() } else { "-" },
        pivot_glossary.len(),
        if resolved_custom_prompt.is_some() { "set" } else { "none" },
        llm_model_id.as_deref().unwrap_or("<none>"),
        preset.as_ref().map(|p| p.name.as_str()).unwrap_or("<none>"),
    );
    body["model_category"] = serde_json::json!(model_category);

    // Pass media_type from preset
    if let Some(ref p) = preset {
        if let Some(ref mt) = p.media_type {
            body["media_type"] = serde_json::json!(mt);
        }
    }


    // Note: media_filename is not currently forwarded to Python. The system
    // prompt improvements already deliver most of the filename-context benefit,
    // and passing the real filename will require frontend plumbing. Revisit
    // when A8 (whisper_model routing) lands — same plumbing pattern.

    // POST /translate/start
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("http://127.0.0.1:{}/translate/start", port))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::PythonServer(format!(
            "Translate start failed: {}",
            text
        )));
    }

    let resp_body: serde_json::Value = resp.json().await?;
    let job_id = resp_body["job_id"]
        .as_str()
        .ok_or_else(|| AppError::PythonServer("Invalid response: missing job_id".into()))?
        .to_string();

    let job = Job::new(job_id.clone(), "translate".to_string());

    // Store job
    {
        let mut s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        s.jobs.insert(job_id.clone(), job.clone());
    }

    // Emit initial job state
    let _ = app.emit("job-updated", &job);

    // Spawn SSE listener for translate stream
    let app_clone = app.clone();
    tokio::spawn(async move {
        sse_client::subscribe_to_translate_stream(app_clone, job_id, port).await;
    });

    Ok(job)
}

#[tauri::command]
pub async fn cancel_translate(
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
            "http://127.0.0.1:{}/translate/cancel/{}",
            port, job_id
        ))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::InvalidState(
            "Failed to cancel translate job".into(),
        ));
    }

    // Immediately update for responsiveness
    {
        let mut s = state.lock().map_err(|e| {
            AppError::InvalidState(format!("Lock error: {}", e))
        })?;
        if let Some(job) = s.jobs.get_mut(&job_id) {
            job.state = crate::job::JobState::CANCELED;
            job.message = Some("Translation cancelled".to_string());
            let _ = app.emit("job-updated", job.clone());
        }
    }

    Ok(())
}
