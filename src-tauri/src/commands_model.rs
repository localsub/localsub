use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::manifest_manager::{self, ModelManifest, ModelManifestEntry};
use crate::model_downloader;
use crate::state::{ModelCatalog, SharedState};

pub(crate) fn load_catalog(app: &AppHandle) -> Result<ModelCatalog, AppError> {
    let resource_path = app
        .path()
        .resolve("model_catalog.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Config(format!("Failed to resolve catalog path: {}", e)))?;

    let data = std::fs::read_to_string(&resource_path)
        .map_err(|e| AppError::Config(format!("Failed to read model catalog: {}", e)))?;

    let catalog: ModelCatalog = serde_json::from_str(&data)
        .map_err(|e| AppError::Config(format!("Failed to parse model catalog: {}", e)))?;

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

    // Extract info needed before spawning — find in whisper first, then llm
    let (model_name, model_type, size_bytes, representative_hash) =
        if let Some(m) = catalog.whisper_models.iter().find(|m| m.id == model_id) {
            (
                m.name.clone(),
                "whisper".to_string(),
                m.total_size_bytes,
                m.sha256.get("model.bin").cloned().unwrap_or_default(),
            )
        } else if let Some(m) = catalog.llm_models.iter().find(|m| m.id == model_id) {
            (
                m.name.clone(),
                "llm".to_string(),
                m.size_bytes,
                m.sha256.clone(),
            )
        } else {
            return Err(AppError::Download(format!(
                "Model '{}' not found in catalog",
                model_id
            )));
        };

    let is_whisper = model_type == "whisper";

    // Get config and set up manifest entry
    let (config, http_client) = {
        let mut s = state
            .lock()
            .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;
        let config = crate::config_manager::ensure_loaded(&mut s)?;
        (config, s.http_client.clone())
    };

    let models_dir = manifest_manager::models_dir(&config)?;
    let dest_dir = models_dir.join(&model_id);

    // Check disk space
    let free_bytes = fs2_free_space(&models_dir);
    if free_bytes > 0 && (free_bytes as u64) < size_bytes {
        return Err(AppError::Download(format!(
            "Insufficient disk space: need {} bytes, have {} bytes",
            size_bytes, free_bytes
        )));
    }

    // Create cancellation token and store it
    let cancel = CancellationToken::new();
    {
        let mut s = state
            .lock()
            .map_err(|e| AppError::Download(format!("Lock error: {}", e)))?;
        s.active_downloads.insert(model_id.clone(), cancel.clone());
    }

    // Update manifest to "downloading" status
    let now = manifest_manager_now();
    let entry = ModelManifestEntry {
        id: model_id.clone(),
        model_type: model_type.clone(),
        name: model_name.clone(),
        path: model_id.clone(),
        size_bytes,
        sha256: representative_hash,
        status: "downloading".to_string(),
        installed_at: now,
    };
    {
        let manifest = manifest_manager::modify_manifest(&config, |m| {
            manifest_manager::upsert_entry(m, entry);
        })?;
        emit_manifest(&app, &manifest);
    }

    // Spawn async download task (non-blocking)
    // Access state through AppHandle inside spawn (avoids lifetime issue with State<'_>)
    let app_clone = app.clone();
    let model_id_clone = model_id.clone();
    let config_clone = config.clone();

    tokio::spawn(async move {
        let result = if is_whisper {
            match catalog.whisper_models.iter().find(|m| m.id == model_id_clone) {
                Some(model) => {
                    model_downloader::download_whisper_model(
                        &http_client,
                        &app_clone,
                        &model.clone(),
                        &dest_dir,
                        cancel.clone(),
                    )
                    .await
                }
                None => Err(AppError::InvalidState(format!(
                    "Whisper model '{}' disappeared from catalog",
                    model_id_clone
                ))),
            }
        } else {
            match catalog.llm_models.iter().find(|m| m.id == model_id_clone) {
                Some(model) => {
                    model_downloader::download_llm_model(
                        &http_client,
                        &app_clone,
                        &model.clone(),
                        &dest_dir,
                        cancel.clone(),
                    )
                    .await
                }
                None => Err(AppError::InvalidState(format!(
                    "LLM model '{}' disappeared from catalog",
                    model_id_clone
                ))),
            }
        };

        // Remove from active downloads via AppHandle
        let shared = app_clone.state::<SharedState>();
        if let Ok(mut s) = shared.lock() {
            s.active_downloads.remove(&model_id_clone);
        }
        drop(shared);

        // Update manifest based on result
        match result {
            Ok(()) => {
                if let Ok(manifest) = manifest_manager::modify_manifest(&config_clone, |m| {
                    if let Some(entry) = m.models.iter_mut().find(|m| m.id == model_id_clone) {
                        entry.status = "ready".to_string();
                    }
                }) {
                    emit_manifest(&app_clone, &manifest);
                }
            }
            Err(ref e) => {
                let error_msg = e.to_string();
                let is_cancel = error_msg.contains("cancelled");
                if !is_cancel {
                    if let Ok(manifest) = manifest_manager::modify_manifest(&config_clone, |m| {
                        if let Some(entry) = m.models.iter_mut().find(|m| m.id == model_id_clone) {
                            entry.status = "corrupt".to_string();
                        }
                    }) {
                        emit_manifest(&app_clone, &manifest);
                    }
                }
                // Emit error event to frontend
                let _ = app_clone.emit("download-error", serde_json::json!({
                    "model_id": model_id_clone,
                    "error": error_msg,
                    "cancelled": is_cancel,
                }));
                log::error!("Download failed for {}: {}", model_id_clone, e);
            }
        }
    });

    Ok(())
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
