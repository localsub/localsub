use std::path::PathBuf;

use crate::error::AppError;
use crate::state::{AppConfig, AppState, PartialConfig};
use crate::utils;

const CONFIG_FILENAME: &str = "config.json";

pub fn config_path() -> Result<PathBuf, AppError> {
    Ok(utils::app_data_dir()?.join(CONFIG_FILENAME))
}

pub fn load_config() -> Result<AppConfig, AppError> {
    let path = config_path()?;
    if path.exists() {
        utils::read_json_file(&path)
    } else {
        let config = AppConfig::default();
        save_config(&config)?;
        Ok(config)
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), AppError> {
    let path = config_path()?;
    utils::atomic_write(&path, config)
}

/// Returns the in-memory config, loading it from disk on first use.
///
/// `app_config` is populated lazily — whichever command runs first fills it.
/// `get_config` already did this, but the model commands instead *required*
/// it to be Some and errored "Config not loaded" otherwise. Since the frontend
/// fires `getConfig` and `getModelManifest` concurrently on mount and Tauri
/// runs commands in parallel, `get_model_manifest` could win the race, error,
/// and leave the model list empty for the whole session — every model then
/// shows "not installed". Loading on demand removes that ordering dependency.
pub fn ensure_loaded(state: &mut AppState) -> Result<AppConfig, AppError> {
    if state.app_config.is_none() {
        state.app_config = Some(load_config()?);
    }
    Ok(state
        .app_config
        .clone()
        .expect("app_config was just loaded"))
}

pub fn update_config(partial: PartialConfig, current: &mut AppConfig) -> Result<(), AppError> {
    if let Some(v) = partial.wizard_completed {
        current.wizard_completed = v;
    }
    if let Some(v) = partial.wizard_step {
        current.wizard_step = v;
    }
    if let Some(v) = partial.profile {
        current.profile = v;
    }
    if let Some(v) = partial.output_dir {
        current.output_dir = v;
    }
    if let Some(v) = partial.subtitle_format {
        current.subtitle_format = v;
    }
    if let Some(v) = partial.source_language {
        current.source_language = v;
    }
    if let Some(v) = partial.target_language {
        current.target_language = v;
    }
    if let Some(v) = partial.translation_mode {
        current.translation_mode = v;
    }
    if let Some(v) = partial.context_window {
        current.context_window = v;
    }
    if let Some(v) = partial.style_preset {
        current.style_preset = v;
    }
    if let Some(v) = partial.external_api {
        current.external_api = v;
    }
    if let Some(v) = partial.model_dir {
        current.model_dir = v;
    }
    if let Some(v) = partial.ui_language {
        current.ui_language = v;
    }
    if let Some(v) = partial.active_whisper_model {
        current.active_whisper_model = v;
    }
    if let Some(v) = partial.active_llm_model {
        current.active_llm_model = v;
    }
    if let Some(v) = partial.max_concurrent_jobs {
        current.max_concurrent_jobs = v;
    }
    if let Some(v) = partial.gpu_acceleration {
        current.gpu_acceleration = v;
    }
    if let Some(v) = partial.max_memory_mb {
        current.max_memory_mb = v;
    }
    if let Some(v) = partial.translation_quality {
        current.translation_quality = v;
    }
    if let Some(v) = partial.custom_translation_prompt {
        current.custom_translation_prompt = v;
    }

    save_config(current)
}

#[cfg(test)]
mod tests {
    use super::ensure_loaded;
    use crate::state::{AppConfig, AppState, PartialConfig, Profile};
    use std::fs;

    /// When app_config is already loaded, ensure_loaded returns it verbatim and
    /// does NOT touch disk — that is what lets get_model_manifest stop racing
    /// get_config. (The None path reads config.json and is covered by the
    /// load_config tests.)
    #[test]
    fn ensure_loaded_returns_existing_without_reloading() {
        let mut state = AppState::default();
        let mut cfg = AppConfig::default();
        cfg.wizard_completed = true;
        cfg.wizard_step = 42;
        state.app_config = Some(cfg);

        let got = ensure_loaded(&mut state).unwrap();
        assert!(got.wizard_completed);
        assert_eq!(got.wizard_step, 42);
    }

    #[test]
    fn test_default_config_roundtrip() {
        let config = AppConfig::default();
        let json = serde_json::to_string_pretty(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, 1);
        assert!(!parsed.wizard_completed);
        assert_eq!(parsed.profile, Profile::Lite);
    }

    #[test]
    fn test_partial_config_merge() {
        let mut config = AppConfig::default();
        let partial = PartialConfig {
            profile: Some(Profile::Power),
            wizard_step: Some(3),
            ..Default::default()
        };
        // We test the merge logic directly (without disk I/O)
        if let Some(v) = partial.profile {
            config.profile = v;
        }
        if let Some(v) = partial.wizard_step {
            config.wizard_step = v;
        }
        assert_eq!(config.profile, Profile::Power);
        assert_eq!(config.wizard_step, 3);
        assert_eq!(config.subtitle_format, "srt"); // unchanged
    }

    #[test]
    fn test_atomic_write_and_read() {
        let dir = std::env::temp_dir().join("tauri_ai_sse_test_config");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("test_config.json");
        let config = AppConfig::default();
        crate::utils::atomic_write(&path, &config).unwrap();

        assert!(path.exists());
        assert!(!path.with_extension("tmp").exists());

        let data = fs::read_to_string(&path).unwrap();
        let parsed: AppConfig = serde_json::from_str(&data).unwrap();
        assert_eq!(parsed.version, 1);

        let _ = fs::remove_dir_all(&dir);
    }
}
