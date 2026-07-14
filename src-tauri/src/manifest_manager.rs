use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppConfig;
use crate::utils;

const MANIFEST_FILENAME: &str = "manifest.json";

/// Serializes manifest read-modify-write across concurrent callers.
///
/// Downloading two models at once (the onboarding wizard does exactly this)
/// runs two `load → upsert → save` sequences against the same file. Without a
/// lock they interleave — both load the same starting manifest, each adds only
/// its own entry, and the second save clobbers the first. A model then finishes
/// downloading yet is missing from the manifest and shows as "not installed".
/// Observed with two downloads starting in the same millisecond.
static MANIFEST_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelManifest {
    pub version: u32,
    pub updated_at: String,
    pub models: Vec<ModelManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelManifestEntry {
    pub id: String,
    pub model_type: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub status: String,
    pub installed_at: String,
}

impl Default for ModelManifest {
    fn default() -> Self {
        Self {
            version: 1,
            updated_at: chrono_now(),
            models: Vec::new(),
        }
    }
}

fn chrono_now() -> String {
    // ISO 8601 timestamp without external chrono dep
    let now = std::time::SystemTime::now();
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple epoch-based timestamp; sufficient for ordering
    format!("{}", secs)
}

pub fn models_dir(config: &AppConfig) -> Result<PathBuf, AppError> {
    if let Some(ref custom) = config.model_dir {
        if !custom.is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    Ok(utils::app_data_dir()?.join("models"))
}

pub fn manifest_path(config: &AppConfig) -> Result<PathBuf, AppError> {
    Ok(models_dir(config)?.join(MANIFEST_FILENAME))
}

pub fn load_manifest(config: &AppConfig) -> Result<ModelManifest, AppError> {
    let path = manifest_path(config)?;
    if path.exists() {
        let data = fs::read_to_string(&path)
            .map_err(|e| AppError::Download(format!("Failed to read manifest: {}", e)))?;
        let manifest: ModelManifest = serde_json::from_str(&data)
            .map_err(|e| AppError::Download(format!("Failed to parse manifest: {}", e)))?;
        Ok(manifest)
    } else {
        Ok(ModelManifest::default())
    }
}

pub fn save_manifest(config: &AppConfig, manifest: &ModelManifest) -> Result<(), AppError> {
    let path = manifest_path(config)?;
    utils::atomic_write(&path, manifest)
}

/// Load the manifest, apply `f`, and save it — all under `MANIFEST_LOCK` so
/// concurrent updates can't clobber each other. Returns the saved manifest so
/// the caller can emit it. Use this for every mutation instead of a bare
/// load/modify/save.
pub fn modify_manifest<F>(config: &AppConfig, f: F) -> Result<ModelManifest, AppError>
where
    F: FnOnce(&mut ModelManifest),
{
    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = load_manifest(config)?;
    f(&mut manifest);
    save_manifest(config, &manifest)?;
    Ok(manifest)
}

pub fn upsert_entry(manifest: &mut ModelManifest, entry: ModelManifestEntry) {
    if let Some(existing) = manifest.models.iter_mut().find(|m| m.id == entry.id) {
        *existing = entry;
    } else {
        manifest.models.push(entry);
    }
    manifest.updated_at = chrono_now();
}

pub fn remove_entry(manifest: &mut ModelManifest, model_id: &str) {
    manifest.models.retain(|m| m.id != model_id);
    manifest.updated_at = chrono_now();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use crate::state::AppConfig;

    fn test_config(dir: &Path) -> AppConfig {
        let mut config = AppConfig::default();
        config.model_dir = Some(dir.to_string_lossy().to_string());
        config
    }

    #[test]
    fn test_empty_manifest_roundtrip() {
        let dir = std::env::temp_dir().join("localsub_manifest_test_1");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let config = test_config(&dir);
        let manifest = load_manifest(&config).unwrap();
        assert_eq!(manifest.version, 1);
        assert!(manifest.models.is_empty());

        save_manifest(&config, &manifest).unwrap();
        let loaded = load_manifest(&config).unwrap();
        assert_eq!(loaded.version, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    /// The onboarding wizard downloads several models at once, and each
    /// completion does its own manifest update. Without serialization those
    /// interleave and clobber each other. Fire many concurrent upserts and
    /// assert every one survives.
    #[test]
    fn modify_manifest_keeps_every_concurrent_upsert() {
        let dir =
            std::env::temp_dir().join(format!("localsub_manifest_race_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let config = std::sync::Arc::new(test_config(&dir));
        save_manifest(&config, &ModelManifest::default()).unwrap();

        let n = 16;
        let handles: Vec<_> = (0..n)
            .map(|i| {
                let config = config.clone();
                std::thread::spawn(move || {
                    modify_manifest(&config, |m| {
                        upsert_entry(
                            m,
                            ModelManifestEntry {
                                id: format!("model-{i}"),
                                model_type: "llm".to_string(),
                                name: format!("Model {i}"),
                                path: format!("model-{i}"),
                                size_bytes: 1,
                                sha256: "x".to_string(),
                                status: "ready".to_string(),
                                installed_at: "0".to_string(),
                            },
                        );
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let final_manifest = load_manifest(&config).unwrap();
        assert_eq!(
            final_manifest.models.len(),
            n,
            "every concurrent upsert must survive; a lost entry means the race is back"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_upsert_and_remove() {
        let mut manifest = ModelManifest::default();

        let entry = ModelManifestEntry {
            id: "whisper-tiny".to_string(),
            model_type: "whisper".to_string(),
            name: "Whisper Tiny".to_string(),
            path: "whisper-tiny".to_string(),
            size_bytes: 77_000_000,
            sha256: "abc123".to_string(),
            status: "ready".to_string(),
            installed_at: chrono_now(),
        };

        upsert_entry(&mut manifest, entry.clone());
        assert_eq!(manifest.models.len(), 1);
        assert_eq!(manifest.models[0].status, "ready");

        // Upsert same id → update
        let mut updated = entry;
        updated.status = "corrupt".to_string();
        upsert_entry(&mut manifest, updated);
        assert_eq!(manifest.models.len(), 1);
        assert_eq!(manifest.models[0].status, "corrupt");

        // Remove
        remove_entry(&mut manifest, "whisper-tiny");
        assert!(manifest.models.is_empty());
    }

    #[test]
    fn test_models_dir_default() {
        let config = AppConfig::default();
        let dir = models_dir(&config).unwrap();
        assert!(dir.to_string_lossy().contains("models"));
    }

    #[test]
    fn test_models_dir_custom() {
        let mut config = AppConfig::default();
        config.model_dir = Some("D:\\MyModels".to_string());
        let dir = models_dir(&config).unwrap();
        assert_eq!(dir, PathBuf::from("D:\\MyModels"));
    }
}
