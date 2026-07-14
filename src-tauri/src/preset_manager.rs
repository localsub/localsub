use crate::error::AppError;
use crate::state::Preset;
use crate::utils::{app_data_dir, atomic_write, read_json_file};

fn presets_path() -> Result<std::path::PathBuf, AppError> {
    Ok(app_data_dir()?.join("presets.json"))
}

pub fn load_presets() -> Result<Vec<Preset>, AppError> {
    let path = presets_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    read_json_file(&path)
}

pub fn save_presets(presets: &[Preset]) -> Result<(), AppError> {
    let path = presets_path()?;
    atomic_write(&path, presets)
}

pub fn add_preset(preset: Preset) -> Result<Vec<Preset>, AppError> {
    let mut presets = load_presets()?;
    presets.push(preset);
    save_presets(&presets)?;
    Ok(presets)
}

pub fn update_preset(updated: Preset) -> Result<Vec<Preset>, AppError> {
    let mut presets = load_presets()?;
    if let Some(p) = presets.iter_mut().find(|p| p.id == updated.id) {
        *p = updated;
    } else {
        return Err(AppError::Config(format!("Preset not found: {}", updated.id)));
    }
    save_presets(&presets)?;
    Ok(presets)
}

pub fn remove_preset(id: &str) -> Result<Vec<Preset>, AppError> {
    let mut presets = load_presets()?;
    let before = presets.len();
    presets.retain(|p| p.id != id);
    if presets.len() == before {
        return Err(AppError::Config(format!("Preset not found: {}", id)));
    }
    save_presets(&presets)?;
    Ok(presets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_preset() -> Preset {
        Preset {
            id: "test-1".to_string(),
            name: "Test Preset".to_string(),
            description: "A test preset".to_string(),
            whisper_model: "base".to_string(),
            source_lang: "en".to_string(),
            target_lang: "ko".to_string(),
            output_format: "srt".to_string(),
            translation_style: "formal".to_string(),
            llm_model: "qwen3-7b".to_string(),
            vocabulary_id: None,
            is_default: None,
            translation_quality: None,
            custom_translation_prompt: None,
            enable_diarization: None,
            media_type: None,
            translation_mode: None,
            pivot_language: None,
            pivot_vocabulary_id: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_preset_serialization_roundtrip() {
        let preset = test_preset();
        let json = serde_json::to_string(&preset).unwrap();
        let restored: Preset = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, "test-1");
        assert_eq!(restored.name, "Test Preset");
        assert_eq!(restored.whisper_model, "base");
        assert!(restored.vocabulary_id.is_none());
    }
}
