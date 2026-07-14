mod commands;
mod commands_config;
mod commands_csv;
mod commands_diarization;
mod commands_ffmpeg;
mod commands_export;
mod commands_job;
mod commands_model;
mod commands_preset;
mod commands_runtime;
mod commands_stt;
mod commands_subtitle;
mod commands_subtitle_import;
mod commands_translate;
mod commands_vocabulary;
mod commands_wizard;
mod config_manager;
mod csv_reader;
mod contracts;
mod error;
mod hw_detector;
mod integrity;
mod job;
mod job_manager;
mod manifest_manager;
mod model_downloader;
mod preset_manager;
mod python_manager;
mod setup_manager;
mod sse_client;
mod state;
mod subtitle_manager;
mod subtitle_reader;
mod subtitle_writer;
mod utils;
mod vocabulary_manager;

use tauri::Manager;

use state::{AppState, SharedState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set up logging to both stderr and file
    let log_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("LocalSub")
        .join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file_path = log_dir.join("tauri.log");

    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    builder.format_timestamp_millis();

    // Add file writer
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
    {
        let file = std::sync::Mutex::new(file);
        builder.format(move |buf, record| {
            use std::io::Write;
            let ts = buf.timestamp_millis();
            let msg = format!("{} [{}] {}: {}\n", ts, record.target(), record.level(), record.args());
            // Write to stderr (default)
            write!(buf, "{}", msg)?;
            // Write to file
            if let Ok(mut f) = file.lock() {
                let _ = f.write_all(msg.as_bytes());
            }
            Ok(())
        });
    }

    builder.init();
    log::info!("Tauri starting (log_file={})", log_file_path.display());

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(SharedState::new(AppState::default()))
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let png_bytes = include_bytes!("../icons/128x128@2x.png");
                let img = image::load_from_memory(png_bytes)
                    .expect("Failed to decode icon");
                let rgba = img.to_rgba8();
                let (w, h) = rgba.dimensions();
                let icon = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
                let _ = window.set_icon(icon);
            }

            // Seed any bundled default vocabularies that aren't installed yet.
            // Runs on every launch but is idempotent: existing IDs are skipped.
            if let Err(e) = vocabulary_manager::ensure_default_vocabularies(&app.handle()) {
                log::warn!("Failed to seed default vocabularies: {}", e);
            }

            // Patch the bundled python312._pth to include the pip-env dir on
            // every launch, independent of the setup-complete gate. A new-path
            // install skips setup and would otherwise never patch its own ._pth,
            // breaking package imports for the embeddable-Python server.
            if let Err(e) = setup_manager::ensure_pth_patched(&app.handle()) {
                log::warn!("Failed to ensure python312._pth patched: {}", e);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Existing commands
            commands::check_setup,
            commands::run_setup,
            commands::reset_setup,
            commands::start_server,
            commands::stop_server,
            commands::restart_server,
            commands::get_server_status,
            commands::get_jobs,
            // Wizard commands
            commands_wizard::detect_hardware,
            commands_wizard::recommend_profile,
            commands_wizard::get_model_catalog,
            commands_wizard::check_disk_space,
            // Config commands
            commands_config::get_config,
            commands_config::update_config,
            // Model commands
            commands_model::download_model,
            commands_model::cancel_download,
            commands_model::delete_model,
            commands_model::get_model_manifest,
            commands_model::verify_model,
            // STT commands
            commands_stt::start_stt,
            commands_stt::cancel_stt,
            // Diarization commands
            commands_diarization::start_diarization,
            commands_diarization::cancel_diarization,
            // Translate commands
            commands_translate::start_translate,
            commands_translate::cancel_translate,
            // Runtime commands
            commands_runtime::get_runtime_status,
            commands_runtime::load_runtime_model,
            commands_runtime::unload_runtime_model,
            // Export commands
            commands_export::export_subtitles,
            commands_export::open_folder,
            // Subtitle commands
            commands_subtitle::load_job_subtitles,
            commands_subtitle::save_job_subtitles,
            // Subtitle import commands
            commands_subtitle_import::read_subtitle_file,
            // Preset commands
            commands_preset::get_presets,
            commands_preset::add_preset,
            commands_preset::update_preset,
            commands_preset::remove_preset,
            // Dashboard job commands
            commands_job::load_dashboard_jobs,
            commands_job::save_dashboard_jobs,
            // Vocabulary commands
            commands_vocabulary::get_vocabularies,
            commands_vocabulary::add_vocabulary,
            commands_vocabulary::update_vocabulary,
            commands_vocabulary::remove_vocabulary,
            // ffmpeg commands
            commands_ffmpeg::check_ffmpeg,
            commands_ffmpeg::get_ffmpeg_path,
            commands_ffmpeg::download_ffmpeg,
            // CSV commands
            commands_csv::read_csv_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<SharedState>();
                let mut s = state.lock().expect("Failed to lock state");
                // Cancel resource polling
                if let Some(token) = s.poll_cancel.take() {
                    token.cancel();
                }
                if let Some(ref mut child) = s.server_process {
                    log::info!("Cleaning up Python server process on exit");
                    let _ = python_manager::kill_server(child);
                }
                s.server_process = None;
            }
        });
}
