use std::path::PathBuf;

use tauri::State;

use crate::contracts::SubtitleSegment;
use crate::error::AppError;
use crate::subtitle_writer;
use crate::state::SharedState;

#[tauri::command]
pub async fn export_subtitles(
    _state: State<'_, SharedState>,
    segments: Vec<SubtitleSegment>,
    format: String,
    output_dir: String,
    file_name: String,
) -> Result<String, AppError> {
    if segments.is_empty() {
        return Err(AppError::InvalidState(
            "No segments to export".into(),
        ));
    }

    // Format subtitles
    let fmt = format.to_lowercase();
    let content = subtitle_writer::format_subtitles(&segments, &fmt);

    // Determine extension
    let ext = match fmt.as_str() {
        "vtt" => "vtt",
        "ass" => "ass",
        "txt" => "txt",
        _ => "srt",
    };

    // Build output path
    let out_path = PathBuf::from(&output_dir).join(format!("{}.{}", file_name, ext));

    // Write file (creates dirs + UTF-8 BOM)
    subtitle_writer::write_subtitle_file(&content, &out_path).map_err(|e| {
        AppError::Io(e)
    })?;

    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_folder(path: String) -> Result<(), AppError> {
    let dir = std::path::Path::new(&path);
    let target = if dir.is_file() {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| AppError::Io(e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(target.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| AppError::Io(e))?;
    }
    Ok(())
}
