use std::path::Path;

use futures::StreamExt;
use reqwest::header;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::integrity::verify_sha256;
use crate::state::{LlmCatalogEntry, WhisperCatalogEntry};

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub file_name: String,
    pub file_index: u32,
    pub total_files: u32,
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub eta_secs: f64,
}

fn hf_url(repo: &str, filename: &str) -> String {
    format!(
        "https://huggingface.co/{}/resolve/main/{}",
        repo, filename
    )
}

pub async fn download_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    cancel: CancellationToken,
    progress_cb: impl Fn(u64, u64, u64, f64),
) -> Result<(), AppError> {
    // Check for existing partial file (resume support)
    let existing_size = if dest.exists() {
        tokio::fs::metadata(dest)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::Download(format!("Failed to create dir: {}", e)))?;
        }
        0
    };

    // Build request with optional Range header
    let mut req = client.get(url);
    if existing_size > 0 {
        log::info!("Resuming download from {} bytes: {}", existing_size, url);
        req = req.header(header::RANGE, format!("bytes={}-", existing_size));
    } else {
        log::info!("Starting download: {}", url);
    }

    let response = req
        .send()
        .await
        .map_err(|e| {
            log::error!("HTTP request failed for {}: {}", url, e);
            AppError::Download(format!("HTTP request failed: {}", e))
        })?;

    let status = response.status();
    log::info!("HTTP {} for {}", status, url);

    // 416 Range Not Satisfiable = file already fully downloaded
    if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE && existing_size > 0 {
        log::info!("File already complete ({} bytes): {:?}", existing_size, dest);
        progress_cb(existing_size, existing_size, 0, 0.0);
        return Ok(());
    }

    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(AppError::Download(format!(
            "HTTP {} for {}",
            status, url
        )));
    }

    // Determine total size and whether we're resuming
    let (mut downloaded, total, append) = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        // Server supports range, resuming
        let content_range = response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        // Content-Range: bytes 12345-99999/100000
        let total = content_range
            .split('/')
            .last()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(existing_size + response.content_length().unwrap_or(0));
        (existing_size, total, true)
    } else {
        // Full download from start
        let total = response.content_length().unwrap_or(0);
        (0u64, total, false)
    };

    // Open file for writing
    let file = if append {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(dest)
            .await
            .map_err(|e| AppError::Download(format!("Failed to open file for append: {}", e)))?
    } else {
        tokio::fs::File::create(dest)
            .await
            .map_err(|e| AppError::Download(format!("Failed to create file: {}", e)))?
    };

    let mut writer = tokio::io::BufWriter::new(file);
    let mut stream = response.bytes_stream();

    // Speed/ETA tracking
    let start_time = std::time::Instant::now();
    let mut last_report = std::time::Instant::now();
    let mut bytes_since_last_report = 0u64;
    let mut current_speed: u64 = 0;

    while let Some(chunk_result) = stream.next().await {
        // Check cancellation
        if cancel.is_cancelled() {
            log::info!("Download cancelled by user: {:?}", dest);
            writer.flush().await.ok();
            return Err(AppError::Download("Download cancelled".to_string()));
        }

        let chunk = chunk_result
            .map_err(|e| {
                log::error!("Stream error for {:?}: {}", dest, e);
                AppError::Download(format!("Stream error: {}", e))
            })?;

        writer
            .write_all(&chunk)
            .await
            .map_err(|e| AppError::Download(format!("Write error: {}", e)))?;

        downloaded += chunk.len() as u64;
        bytes_since_last_report += chunk.len() as u64;

        // Report progress every 500ms
        let now = std::time::Instant::now();
        if now.duration_since(last_report).as_millis() >= 500 {
            let elapsed_secs = now.duration_since(last_report).as_secs_f64();
            if elapsed_secs > 0.0 {
                current_speed = (bytes_since_last_report as f64 / elapsed_secs) as u64;
            }
            let eta = if current_speed > 0 && total > downloaded {
                (total - downloaded) as f64 / current_speed as f64
            } else {
                0.0
            };

            progress_cb(downloaded, total, current_speed, eta);

            last_report = now;
            bytes_since_last_report = 0;
        }
    }

    writer.flush().await.map_err(|e| {
        AppError::Download(format!("Failed to flush file: {}", e))
    })?;

    // Final progress report
    let elapsed = start_time.elapsed().as_secs_f64();
    let avg_speed = if elapsed > 0.0 {
        (downloaded as f64 / elapsed) as u64
    } else {
        0
    };
    progress_cb(downloaded, total, avg_speed, 0.0);

    log::info!(
        "Download complete: {:?} ({} bytes in {:.1}s, avg {:.1} MB/s)",
        dest,
        downloaded,
        elapsed,
        avg_speed as f64 / 1_048_576.0
    );

    Ok(())
}

pub async fn download_whisper_model(
    client: &reqwest::Client,
    app: &AppHandle,
    model: &WhisperCatalogEntry,
    dest_dir: &Path,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    let total_files = model.files.len() as u32;
    log::info!(
        "Starting whisper model download: {} ({} files, repo: {})",
        model.id, total_files, model.repo
    );

    tokio::fs::create_dir_all(dest_dir)
        .await
        .map_err(|e| AppError::Download(format!("Failed to create model dir: {}", e)))?;

    for (i, filename) in model.files.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(AppError::Download("Download cancelled".to_string()));
        }

        let url = hf_url(&model.repo, filename);
        let dest = dest_dir.join(filename);
        let model_id = model.id.clone();
        let file_name = filename.clone();
        let file_index = i as u32;
        let app_clone = app.clone();

        download_file(client, &url, &dest, cancel.clone(), |downloaded, total, speed, eta| {
            let _ = app_clone.emit(
                "download-progress",
                DownloadProgress {
                    model_id: model_id.clone(),
                    file_name: file_name.clone(),
                    file_index,
                    total_files,
                    downloaded,
                    total,
                    speed_bps: speed,
                    eta_secs: eta,
                },
            );
        })
        .await?;

        // Verify hash for files that have a hash in the catalog
        if let Some(expected_hash) = model.sha256.get(filename) {
            let app_clone = app.clone();
            let model_id = model.id.clone();
            let file_name = filename.clone();

            // Emit verifying state
            let _ = app_clone.emit(
                "download-progress",
                DownloadProgress {
                    model_id: model_id.clone(),
                    file_name: file_name.clone(),
                    file_index: i as u32,
                    total_files,
                    downloaded: 0,
                    total: 0,
                    speed_bps: 0,
                    eta_secs: 0.0,
                },
            );

            let valid = verify_sha256(&dest, expected_hash).await?;
            if !valid {
                // Delete corrupt file so it can be re-downloaded
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(AppError::Download(format!(
                    "SHA-256 mismatch for {}/{}",
                    model.id, filename
                )));
            }
        }
    }

    Ok(())
}

pub async fn download_llm_model(
    client: &reqwest::Client,
    app: &AppHandle,
    model: &LlmCatalogEntry,
    dest_dir: &Path,
    cancel: CancellationToken,
) -> Result<(), AppError> {
    log::info!(
        "Starting LLM model download: {} ({:.1} GB, repo: {})",
        model.id,
        model.size_bytes as f64 / 1_073_741_824.0,
        model.repo
    );

    tokio::fs::create_dir_all(dest_dir)
        .await
        .map_err(|e| AppError::Download(format!("Failed to create model dir: {}", e)))?;

    // Build list of files to download: split_files if present, otherwise single file
    let files_to_download: Vec<(String, String)> = match &model.split_files {
        Some(splits) if !splits.is_empty() => splits
            .iter()
            .map(|sf| (sf.filename.clone(), sf.sha256.clone()))
            .collect(),
        _ => vec![(model.filename.clone(), model.sha256.clone())],
    };

    let total_files = files_to_download.len() as u32;

    for (i, (filename, expected_hash)) in files_to_download.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(AppError::Download("Download cancelled".to_string()));
        }

        let url = hf_url(&model.repo, filename);
        let dest = dest_dir.join(filename);
        let model_id = model.id.clone();
        let file_name = filename.clone();
        let file_index = i as u32;
        let app_clone = app.clone();

        download_file(client, &url, &dest, cancel.clone(), |downloaded, total, speed, eta| {
            let _ = app_clone.emit(
                "download-progress",
                DownloadProgress {
                    model_id: model_id.clone(),
                    file_name: file_name.clone(),
                    file_index,
                    total_files,
                    downloaded,
                    total,
                    speed_bps: speed,
                    eta_secs: eta,
                },
            );
        })
        .await?;

        // Verify hash
        let app_clone = app.clone();
        let model_id = model.id.clone();
        let file_name = filename.clone();

        let _ = app_clone.emit(
            "download-progress",
            DownloadProgress {
                model_id: model_id.clone(),
                file_name: file_name.clone(),
                file_index: i as u32,
                total_files,
                downloaded: 0,
                total: 0,
                speed_bps: 0,
                eta_secs: 0.0,
            },
        );

        let valid = verify_sha256(&dest, expected_hash).await?;
        if !valid {
            let _ = tokio::fs::remove_file(&dest).await;
            return Err(AppError::Download(format!(
                "SHA-256 mismatch for {}/{}",
                model.id, filename
            )));
        }
    }

    Ok(())
}
