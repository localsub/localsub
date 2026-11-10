use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::manifest_manager::{self, ModelManifest, ModelManifestEntry};
use crate::model_downloader;
use crate::state::{ModelCatalog, SharedState, WhisperCatalogEntry};
use crate::stt_catalog;

pub(crate) fn load_catalog(app: &AppHandle) -> Result<ModelCatalog, AppError> {
    let resource_path = app
        .path()
        .resolve("model_catalog.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Config(format!("Failed to resolve catalog path: {}", e)))?;

    let data = std::fs::read_to_string(&resource_path)
        .map_err(|e| AppError::Config(format!("Failed to read model catalog: {}", e)))?;

    let catalog: ModelCatalog = serde_json::from_str(&data)
        .map_err(|e| AppError::Config(format!("Failed to parse model catalog: {}", e)))?;
    stt_catalog::validate(&catalog)
        .map_err(|e| AppError::Config(format!("Invalid model catalog: {}", e)))?;

    Ok(catalog)
}

fn emit_manifest(app: &AppHandle, manifest: &ModelManifest) {
    let _ = app.emit("model-manifest", &manifest.models);
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, SharedState>,
    model_id: String,
) -> Result<(), AppError> {
    let catalog = load_catalog(&app)?;

    let is_whisper = stt_catalog::find(&catalog, &model_id).is_some();
    if !is_whisper && !catalog.llm_models.iter().any(|m| m.id == model_id) {
        return Err(AppError::Download(format!(
            "Model '{}' not found in catalog",
            model_id
        )));
    }

    // Get config and set up manifest entry
    let (config, http_client) = {
        let mut s = state
            .lock()
            .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;
        let config = crate::config_manager::ensure_loaded(&mut s)?;
        (config, s.http_client.clone())
    };

    let models_dir = manifest_manager::models_dir(&config)?;

    // Every manifest entry this download creates, in download order. An STT
    // model that needs helpers (an aligner) brings them along, so the user
    // clicks once and gets a working model.
    let entries: Vec<ModelManifestEntry> = if is_whisper {
        let manifest = manifest_manager::load_manifest(&config)?;
        let ready = |id: &str| {
            manifest
                .models
                .iter()
                .any(|m| m.id == id && m.status == "ready")
        };
        stt_catalog::download_plan(&catalog, &model_id, ready)?
            .into_iter()
            .map(|m| {
                manifest_entry(
                    &m.id,
                    "whisper",
                    &m.name,
                    m.total_size_bytes,
                    stt_catalog::representative_hash(m),
                )
            })
            .collect()
    } else {
        let m = catalog
            .llm_models
            .iter()
            .find(|m| m.id == model_id)
            .expect("checked above");
        vec![manifest_entry(&m.id, "llm", &m.name, m.size_bytes, m.sha256.clone())]
    };
    let size_bytes: u64 = entries.iter().map(|e| e.size_bytes).sum();

    // Check disk space
    let free_bytes = fs2_free_space(&models_dir);
    if free_bytes > 0 && (free_bytes as u64) < size_bytes {
        return Err(AppError::Download(format!(
            "Insufficient disk space: need {} bytes, have {} bytes",
            size_bytes, free_bytes
        )));
    }

    // Create cancellation token and store it under every id the download
    // touches, so none of them can be deleted mid-download.
    let cancel = CancellationToken::new();
    {
        let mut s = state
            .lock()
            .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;
        for e in &entries {
            s.active_downloads.insert(e.id.clone(), cancel.clone());
        }
    }

    // Update manifest to "downloading" status
    {
        let manifest = manifest_manager::modify_manifest(&config, |m| {
            for e in &entries {
                manifest_manager::upsert_entry(m, e.clone());
            }
        })?;
        emit_manifest(&app, &manifest);
    }

    // Spawn async download task (non-blocking)
    // Access state through AppHandle inside spawn (avoids lifetime issue with State<'_>)
    let app_clone = app.clone();
    let model_id_clone = model_id.clone();
    let config_clone = config.clone();
    let ids: Vec<String> = entries.iter().map(|e| e.id.clone()).collect();

    tokio::spawn(async move {
        let mut done: Vec<String> = Vec::new();
        let result: Result<(), AppError> = async {
            if is_whisper {
                // An engine that is not in the base setup (Qwen3-ASR) first gets
                // its Python packages, as part of this same download: the user
                // never installs "components" as a separate step. No-op once
                // installed; progress arrives as "engine-pack-progress".
                let engine = stt_catalog::find(&catalog, &model_id_clone)
                    .map(|m| m.engine)
                    .unwrap_or_default();
                if crate::engine_pack::lock_file(engine).is_some() {
                    let app_pack = app_clone.clone();
                    let installed = tauri::async_runtime::spawn_blocking(move || {
                        crate::engine_pack::install(&app_pack, engine)
                    })
                    .await
                    .map_err(|e| AppError::Setup(format!("Engine pack task failed: {}", e)))
                    .and_then(|r| r);
                    if let Err(e) = installed {
                        // Nothing was downloaded: drop the entries instead of
                        // marking them "corrupt", so the card returns to its
                        // download button (the event says why it failed).
                        if let Ok(m) = manifest_manager::modify_manifest(&config_clone, |m| {
                            for id in &ids {
                                manifest_manager::remove_entry(m, id);
                            }
                        }) {
                            emit_manifest(&app_clone, &m);
                        }
                        done.extend(ids.iter().cloned());
                        return Err(e);
                    }
                    if cancel.is_cancelled() {
                        return Err(AppError::Download("Download cancelled".to_string()));
                    }
                }
                let plan: Vec<WhisperCatalogEntry> = ids
                    .iter()
                    .filter_map(|id| stt_catalog::find(&catalog, id).cloned())
                    .collect();
                let total_files: u32 = plan.iter().map(|m| m.files.len() as u32).sum();
                let mut file_offset = 0u32;
                for model in &plan {
                    model_downloader::download_whisper_model(
                        &http_client,
                        &app_clone,
                        model,
                        &models_dir.join(&model.id),
                        cancel.clone(),
                        model_downloader::ProgressSlot {
                            model_id: &model_id_clone,
                            file_offset,
                            total_files,
                        },
                    )
                    .await?;
                    file_offset += model.files.len() as u32;
                    mark(&app_clone, &config_clone, &model.id, "ready");
                    done.push(model.id.clone());
                }
                Ok(())
            } else {
                match catalog.llm_models.iter().find(|m| m.id == model_id_clone) {
                    Some(model) => {
                        model_downloader::download_llm_model(
                            &http_client,
                            &app_clone,
                            &model.clone(),
                            &models_dir.join(&model_id_clone),
                            cancel.clone(),
                        )
                        .await?;
                        mark(&app_clone, &config_clone, &model_id_clone, "ready");
                        Ok(())
                    }
                    None => Err(AppError::InvalidState(format!(
                        "LLM model '{}' disappeared from catalog",
                        model_id_clone
                    ))),
                }
            }
        }
        .await;

        // Remove from active downloads via AppHandle
        let shared = app_clone.state::<SharedState>();
        if let Ok(mut s) = shared.lock() {
            for id in &ids {
                s.active_downloads.remove(id);
            }
        }
        drop(shared);

        if let Err(ref e) = result {
            let error_msg = e.to_string();
            let is_cancel = error_msg.contains("cancelled");
            if !is_cancel {
                // Everything that did not finish is unusable, helpers included.
                for id in ids.iter().filter(|id| !done.contains(id)) {
                    mark(&app_clone, &config_clone, id, "corrupt");
                }
            }
            // Emit error event to frontend
            let _ = app_clone.emit(
                "download-error",
                serde_json::json!({
                    "model_id": model_id_clone,
                    "error": error_msg,
                    "cancelled": is_cancel,
                }),
            );
            log::error!("Download failed for {}: {}", model_id_clone, e);
        }
    });

    Ok(())
}

fn manifest_entry(
    id: &str,
    model_type: &str,
    name: &str,
    size_bytes: u64,
    sha256: String,
) -> ModelManifestEntry {
    ModelManifestEntry {
        id: id.to_string(),
        model_type: model_type.to_string(),
        name: name.to_string(),
        path: id.to_string(),
        size_bytes,
        sha256,
        status: "downloading".to_string(),
        installed_at: manifest_manager_now(),
    }
}

fn mark(app: &AppHandle, config: &crate::state::AppConfig, id: &str, status: &str) {
    if let Ok(manifest) = manifest_manager::modify_manifest(config, |m| {
        if let Some(entry) = m.models.iter_mut().find(|m| m.id == id) {
            entry.status = status.to_string();
        }
    }) {
        emit_manifest(app, &manifest);
    }
}

#[tauri::command]
pub async fn cancel_download(
    state: State<'_, SharedState>,
    model_id: String,
) -> Result<(), AppError> {
    let s = state
        .lock()
        .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;

    if let Some(token) = s.active_downloads.get(&model_id) {
        token.cancel();
        Ok(())
    } else {
        Err(AppError::Download(format!(
            "No active download for '{}'",
            model_id
        )))
    }
}

#[tauri::command]
pub async fn delete_model(
    app: AppHandle,
    state: State<'_, SharedState>,
    model_id: String,
) -> Result<(), AppError> {
    let config = {
        let mut s = state
            .lock()
            .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;

        // Prevent deleting while downloading
        if s.active_downloads.contains_key(&model_id) {
            return Err(AppError::Download(format!(
                "Model '{}' is currently downloading. Cancel the download first.",
                model_id
            )));
        }

        crate::config_manager::ensure_loaded(&mut s)?
    };

    // Read the entry's path (plain load — we only need where the files live).
    let entry_path = {
        let manifest = manifest_manager::load_manifest(&config)?;
        manifest
            .models
            .iter()
            .find(|m| m.id == model_id)
            .map(|m| m.path.clone())
            .ok_or_else(|| {
                AppError::Download(format!("Model '{}' not found in manifest", model_id))
            })?
    };

    // Delete files
    let models_dir = manifest_manager::models_dir(&config)?;
    let model_path = models_dir.join(&entry_path);

    if model_path.is_dir() {
        std::fs::remove_dir_all(&model_path)
            .map_err(|e| AppError::Download(format!("Failed to delete model dir: {}", e)))?;
    } else if model_path.is_file() {
        std::fs::remove_file(&model_path)
            .map_err(|e| AppError::Download(format!("Failed to delete model file: {}", e)))?;
    }

    // Remove from manifest (serialized so a concurrent download can't clobber it)
    let manifest = manifest_manager::modify_manifest(&config, |m| {
        manifest_manager::remove_entry(m, &model_id);
    })?;
    emit_manifest(&app, &manifest);

    // Helpers (an aligner) are never shown as a model of their own, so the
    // user cannot delete them. Free them with the last model that needed them,
    // or they sit on disk unseen. Best effort: the model itself is gone.
    if let Ok(catalog) = load_catalog(&app) {
        let mut installed: Vec<String> = manifest.models.iter().map(|m| m.id.clone()).collect();
        installed.push(model_id.clone());
        // Last model of an engine with an on-demand pack: the pack goes too.
        if let Some(engine) = stt_catalog::find(&catalog, &model_id).map(|m| m.engine) {
            if !stt_catalog::engine_still_used(&catalog, &installed, &model_id, engine) {
                let busy = state.lock().map(|s| !s.active_downloads.is_empty()).unwrap_or(true);
                if !busy {
                    tauri::async_runtime::spawn_blocking(move || crate::engine_pack::remove(engine));
                }
            }
        }
        let busy: Vec<String> = state
            .lock()
            .map(|s| s.active_downloads.keys().cloned().collect())
            .unwrap_or_default();
        for helper in stt_catalog::orphaned_helpers(&catalog, &installed, &model_id) {
            if busy.contains(&helper) {
                continue;
            }
            let Some(path) = manifest
                .models
                .iter()
                .find(|m| m.id == helper)
                .map(|m| models_dir.join(&m.path))
            else {
                continue;
            };
            if path.is_dir() {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    log::warn!("Could not delete unused helper model {}: {}", helper, e);
                    continue;
                }
            }
            if let Ok(m) = manifest_manager::modify_manifest(&config, |m| {
                manifest_manager::remove_entry(m, &helper);
            }) {
                log::info!("Deleted helper model {} (no installed model needs it)", helper);
                emit_manifest(&app, &m);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_model_manifest(
    state: State<'_, SharedState>,
) -> Result<ModelManifest, AppError> {
    let config = {
        let mut s = state
            .lock()
            .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;
        crate::config_manager::ensure_loaded(&mut s)?
    };

    manifest_manager::load_manifest(&config)
}

#[tauri::command]
pub async fn verify_model(
    app: AppHandle,
    state: State<'_, SharedState>,
    model_id: String,
) -> Result<String, AppError> {
    let config = {
        let mut s = state
            .lock()
            .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;
        crate::config_manager::ensure_loaded(&mut s)?
    };

    let manifest = manifest_manager::load_manifest(&config)?;
    let entry = manifest
        .models
        .iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| {
            AppError::Download(format!("Model '{}' not found in manifest", model_id))
        })?;

    let models_dir = manifest_manager::models_dir(&config)?;
    let model_path = models_dir.join(&entry.path);

    // Check existence
    if !model_path.exists() {
        return Ok("missing".to_string());
    }

    // STT models: every file the catalog pins. A model the catalog no longer
    // lists falls through to the old model.bin check below.
    if entry.model_type == "whisper" {
        let catalog_entry = load_catalog(&app)
            .ok()
            .and_then(|c| stt_catalog::find(&c, &model_id).cloned());
        if let Some(catalog_entry) = catalog_entry {
            for (file, hash) in stt_catalog::files_to_verify(&catalog_entry) {
                let path = model_path.join(&file);
                if !path.exists() {
                    return Ok("missing".to_string());
                }
                if !crate::integrity::verify_sha256(&path, &hash).await? {
                    return Ok("corrupt".to_string());
                }
            }
            return Ok("ready".to_string());
        }
    }

    // For whisper models, verify model.bin hash
    // For llm models, verify the single file hash
    let file_to_check = if entry.model_type == "whisper" {
        model_path.join("model.bin")
    } else {
        // LLM: the entry.path is the directory, find the file inside
        // Try to find .gguf file
        let mut found = None;
        if let Ok(entries) = std::fs::read_dir(&model_path) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".gguf") {
                    found = Some(e.path());
                    break;
                }
            }
        }
        found.unwrap_or(model_path.clone())
    };

    if !file_to_check.exists() {
        return Ok("missing".to_string());
    }

    let valid = crate::integrity::verify_sha256(&file_to_check, &entry.sha256).await?;
    if valid {
        Ok("ready".to_string())
    } else {
        Ok("corrupt".to_string())
    }
}

fn manifest_manager_now() -> String {
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}", secs)
}

/// Free bytes on the volume holding `path` (0 if it can't be determined).
pub(crate) fn fs2_free_space(path: &std::path::Path) -> u64 {
    // Use sysinfo or simple check; for now check parent that exists
    let check_path = if path.exists() {
        path.to_path_buf()
    } else if let Some(parent) = path.parent() {
        if parent.exists() {
            parent.to_path_buf()
        } else {
            return 0; // Can't determine
        }
    } else {
        return 0;
    };

    // Use Windows API via std to get free space
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = check_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_bytes: u64 = 0;
        unsafe {
            // GetDiskFreeSpaceExW
            #[link(name = "kernel32")]
            extern "system" {
                fn GetDiskFreeSpaceExW(
                    lpDirectoryName: *const u16,
                    lpFreeBytesAvailableToCaller: *mut u64,
                    lpTotalNumberOfBytes: *mut u64,
                    lpTotalNumberOfFreeBytes: *mut u64,
                ) -> i32;
            }
            let mut total: u64 = 0;
            let mut total_free: u64 = 0;
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_bytes, &mut total, &mut total_free);
        }
        free_bytes
    }

    #[cfg(not(target_os = "windows"))]
    {
        0 // Skip disk space check on non-Windows
    }
}

fn parse_engine(engine: &str) -> Result<crate::state::SttEngine, AppError> {
    serde_json::from_value(serde_json::Value::String(engine.to_string()))
        .map_err(|_| AppError::Config(format!("Unknown STT engine: {}", engine)))
}

/// Whether the Python packages an STT engine needs are installed.
#[tauri::command]
pub async fn get_engine_pack_status(
    app: AppHandle,
    engine: String,
) -> Result<crate::engine_pack::PackStatus, AppError> {
    crate::engine_pack::status(&app, parse_engine(&engine)?)
}

/// Installs an engine's pack (no-op if ready). Progress and failure arrive as
/// "engine-pack-progress" events; the frontend runs this as part of a model
/// download, so the user only ever sees one download.
#[tauri::command]
pub async fn install_engine_pack(
    app: AppHandle,
    engine: String,
) -> Result<crate::engine_pack::PackStatus, AppError> {
    let engine = parse_engine(&engine)?;
    tauri::async_runtime::spawn_blocking(move || crate::engine_pack::install(&app, engine))
        .await
        .map_err(|e| AppError::Setup(format!("Engine pack task failed: {}", e)))?
}
