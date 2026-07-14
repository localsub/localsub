use std::fs;
use crate::error::AppError;
use crate::state::Vocabulary;
use crate::utils::{app_data_dir, atomic_write};

fn vocabularies_dir() -> Result<std::path::PathBuf, AppError> {
    let dir = app_data_dir()?.join("vocabularies");
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::Config(format!("Failed to create vocabularies dir: {}", e)))?;
    Ok(dir)
}

fn vocab_path(id: &str) -> Result<std::path::PathBuf, AppError> {
    Ok(vocabularies_dir()?.join(format!("{}.json", id)))
}

pub fn load_vocabularies() -> Result<Vec<Vocabulary>, AppError> {
    let dir = vocabularies_dir()?;
    let mut vocabs = Vec::new();

    let entries = fs::read_dir(&dir)
        .map_err(|e| AppError::Config(format!("Failed to read vocabularies dir: {}", e)))?;

    for entry in entries {
        let entry = entry
            .map_err(|e| AppError::Config(format!("Failed to read dir entry: {}", e)))?;
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "json") {
            let data = fs::read_to_string(&path)
                .map_err(|e| AppError::Config(format!("Failed to read vocabulary file: {}", e)))?;
            match serde_json::from_str::<Vocabulary>(&data) {
                Ok(vocab) => vocabs.push(vocab),
                Err(e) => {
                    log::warn!("Skipping malformed vocabulary {:?}: {}", path, e);
                }
            }
        }
    }

    vocabs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(vocabs)
}

pub fn save_vocabulary(vocab: &Vocabulary) -> Result<(), AppError> {
    let path = vocab_path(&vocab.id)?;
    atomic_write(&path, vocab)
}

pub fn add_vocabulary(vocab: Vocabulary) -> Result<Vec<Vocabulary>, AppError> {
    save_vocabulary(&vocab)?;
    load_vocabularies()
}

pub fn update_vocabulary(updated: Vocabulary) -> Result<Vec<Vocabulary>, AppError> {
    let path = vocab_path(&updated.id)?;
    if !path.exists() {
        return Err(AppError::Config(format!("Vocabulary not found: {}", updated.id)));
    }
    save_vocabulary(&updated)?;
    load_vocabularies()
}

pub fn remove_vocabulary(id: &str) -> Result<Vec<Vocabulary>, AppError> {
    let path = vocab_path(id)?;
    if !path.exists() {
        return Err(AppError::Config(format!("Vocabulary not found: {}", id)));
    }
    fs::remove_file(&path)
        .map_err(|e| AppError::Config(format!("Failed to delete vocabulary: {}", e)))?;
    load_vocabularies()
}

/// Copy any bundled default vocabularies into the user's vocabularies
/// directory if the user does not already have a file with the same ID.
///
/// Idempotent: if the user has already installed / edited / deleted a
/// default, we do not overwrite it. Deletion is a one-shot — the file
/// will be re-seeded on the next launch.
pub fn ensure_default_vocabularies(app: &tauri::AppHandle) -> Result<(), AppError> {
    use tauri::Manager;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::Config(format!("Failed to resolve resource dir: {}", e)))?;
    let defaults_dir = resource_dir.join("default_vocabularies");

    if !defaults_dir.exists() {
        log::info!("No default_vocabularies/ in resources — skipping seed.");
        return Ok(());
    }

    let target_dir = vocabularies_dir()?;
    let existing = load_vocabularies().unwrap_or_default();
    let existing_ids: std::collections::HashSet<String> =
        existing.iter().map(|v| v.id.clone()).collect();

    let entries = fs::read_dir(&defaults_dir).map_err(|e| {
        AppError::Config(format!("Failed to read default_vocabularies: {}", e))
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            AppError::Config(format!("Failed to read default vocab entry: {}", e))
        })?;
        let path = entry.path();
        if !path.extension().map_or(false, |ext| ext == "json") {
            continue;
        }

        let data = fs::read_to_string(&path).map_err(|e| {
            AppError::Config(format!("Failed to read default vocab file: {}", e))
        })?;
        let vocab: Vocabulary = match serde_json::from_str(&data) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("Skipping malformed default vocab {:?}: {}", path, e);
                continue;
            }
        };

        if existing_ids.contains(&vocab.id) {
            log::info!("Default vocabulary '{}' already installed, skipping", vocab.id);
            continue;
        }

        save_vocabulary(&vocab)?;
        log::info!(
            "Installed default vocabulary '{}' ({} entries) into {}",
            vocab.id,
            vocab.entries.len(),
            target_dir.display()
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_vocabulary() -> Vocabulary {
        Vocabulary {
            id: "test-vocab-1".to_string(),
            name: "Test Vocab".to_string(),
            description: "A test vocabulary".to_string(),
            source_lang: "en".to_string(),
            target_lang: "ko".to_string(),
            entries: vec![],
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_vocabulary_serialization_roundtrip() {
        let vocab = test_vocabulary();
        let json = serde_json::to_string(&vocab).unwrap();
        let restored: Vocabulary = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, "test-vocab-1");
        assert_eq!(restored.name, "Test Vocab");
        assert!(restored.entries.is_empty());
    }

    #[test]
    fn test_id_collision_logic() {
        // Simulated "existing" vocabularies
        let existing = vec![test_vocabulary()];
        let existing_ids: std::collections::HashSet<String> =
            existing.iter().map(|v| v.id.clone()).collect();

        // A "default" with the same id must be detected
        let default_with_same_id = test_vocabulary();
        assert!(existing_ids.contains(&default_with_same_id.id));

        // A default with a different id is not in the set
        let different = Vocabulary {
            id: "some-other-id".to_string(),
            ..test_vocabulary()
        };
        assert!(!existing_ids.contains(&different.id));
    }
}
