//! STT catalog rules that do not touch the network or the filesystem:
//! which entries a download pulls in, which helper models a delete leaves
//! orphaned, which files `verify_model` checks, and what `start_stt` tells the
//! Python server about the engine. Kept pure so every rule has a unit test.

use std::collections::{BTreeMap, HashSet};

use crate::error::AppError;
use crate::state::{ModelCatalog, SttRole, WhisperCatalogEntry};

pub fn find<'a>(catalog: &'a ModelCatalog, id: &str) -> Option<&'a WhisperCatalogEntry> {
    catalog.whisper_models.iter().find(|m| m.id == id)
}

/// Whether `id` can be the STT model a job runs with: anything but a helper
/// (the forced aligner). Ids not in the catalog are not helpers.
pub fn is_selectable(catalog: &ModelCatalog, id: &str) -> bool {
    find(catalog, id).is_none_or(|e| e.role != SttRole::Aligner)
}

/// The hash recorded in the manifest for an STT entry: `model.bin`'s for
/// Whisper (as before), otherwise the first hashed file by name.
pub fn representative_hash(entry: &WhisperCatalogEntry) -> String {
    if let Some(h) = entry.sha256.get("model.bin") {
        return h.clone();
    }
    let mut names: Vec<&String> = entry.sha256.keys().collect();
    names.sort();
    names
        .first()
        .and_then(|n| entry.sha256.get(*n))
        .cloned()
        .unwrap_or_default()
}

/// Entries to download, in order, when the user downloads `id`: its
/// `requires` that are not installed yet, then `id` itself.
///
/// The user asked for one model and gets one download (rule zero: no helper
/// models to fetch by hand). A required entry that is missing from the catalog
/// is a catalog bug, reported before anything is downloaded.
pub fn download_plan<'a>(
    catalog: &'a ModelCatalog,
    id: &str,
    is_ready: impl Fn(&str) -> bool,
) -> Result<Vec<&'a WhisperCatalogEntry>, AppError> {
    let entry = find(catalog, id)
        .ok_or_else(|| AppError::Download(format!("Model '{}' not found in catalog", id)))?;
    let mut plan = Vec::new();
    for req in &entry.requires {
        let dep = find(catalog, req).ok_or_else(|| {
            AppError::Config(format!("Catalog entry '{}' requires unknown model '{}'", id, req))
        })?;
        if !is_ready(&dep.id) {
            plan.push(dep);
        }
    }
    plan.push(entry);
    Ok(plan)
}

/// Helper models (`role: aligner`) that become unused once `deleted` is gone:
/// installed, required by `deleted`, and required by no other installed entry.
pub fn orphaned_helpers(
    catalog: &ModelCatalog,
    installed: &[String],
    deleted: &str,
) -> Vec<String> {
    let Some(entry) = find(catalog, deleted) else {
        return Vec::new();
    };
    let still_needed: HashSet<&str> = installed
        .iter()
        .filter(|id| id.as_str() != deleted)
        .filter_map(|id| find(catalog, id))
        .flat_map(|e| e.requires.iter().map(String::as_str))
        .collect();
    entry
        .requires
        .iter()
        .filter(|req| installed.iter().any(|i| i == *req))
        .filter(|req| !still_needed.contains(req.as_str()))
        .filter(|req| find(catalog, req).is_some_and(|e| e.role == SttRole::Aligner))
        .cloned()
        .collect()
}

/// Whether any installed model (other than `deleted`) still runs on `engine`.
/// When none does, the engine's on-demand pack can go too.
pub fn engine_still_used(
    catalog: &ModelCatalog,
    installed: &[String],
    deleted: &str,
    engine: crate::state::SttEngine,
) -> bool {
    installed
        .iter()
        .filter(|id| id.as_str() != deleted)
        .filter_map(|id| find(catalog, id))
        .any(|e| e.engine == engine && e.role == SttRole::Stt)
}

/// (file name, expected sha256) pairs `verify_model` checks, sorted by name.
pub fn files_to_verify(entry: &WhisperCatalogEntry) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> =
        entry.sha256.iter().map(|(f, h)| (f.clone(), h.clone())).collect();
    files.sort();
    files
}

/// `engine` and `aux_models` for the Python `/stt/start` body. A model the
/// catalog does not know runs on the default engine with no helpers.
pub fn stt_request_extras(
    catalog: Option<&ModelCatalog>,
    model_id: &str,
) -> (&'static str, BTreeMap<String, String>) {
    let mut aux = BTreeMap::new();
    let Some(entry) = catalog.and_then(|c| find(c, model_id)) else {
        return (crate::state::SttEngine::default().as_str(), aux);
    };
    if let Some(catalog) = catalog {
        for req in &entry.requires {
            if find(catalog, req).is_some_and(|e| e.role == SttRole::Aligner) {
                aux.insert("aligner".to_string(), req.clone());
            }
        }
    }
    (entry.engine.as_str(), aux)
}

/// Catalog rules every bundled STT entry must satisfy.
pub fn validate(catalog: &ModelCatalog) -> Result<(), String> {
    let mut seen = HashSet::new();
    for e in &catalog.whisper_models {
        if !seen.insert(e.id.as_str()) {
            return Err(format!("duplicate STT id '{}'", e.id));
        }
        for f in e.sha256.keys() {
            if !e.files.contains(f) {
                return Err(format!("{}: sha256 for '{}' which is not in files", e.id, f));
            }
        }
        // Non-Whisper entries were added after per-file pinning became the
        // rule: every file must be hash-pinned (Whisper's model.bin-only pins
        // predate it and are tracked separately).
        if e.engine != crate::state::SttEngine::FasterWhisper {
            for f in &e.files {
                if !e.sha256.contains_key(f) {
                    return Err(format!("{}: file '{}' has no sha256", e.id, f));
                }
            }
        }
        if e.role == SttRole::Aligner && !e.requires.is_empty() {
            return Err(format!("{}: an aligner cannot require other models", e.id));
        }
        for req in &e.requires {
            match find(catalog, req) {
                None => return Err(format!("{} requires unknown '{}'", e.id, req)),
                Some(dep) if dep.role != SttRole::Aligner => {
                    return Err(format!("{} requires '{}', which is not an aligner", e.id, req))
                }
                Some(dep) if dep.engine != e.engine => {
                    return Err(format!("{} requires '{}' of another engine", e.id, req))
                }
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: &str = "0000000000000000000000000000000000000000000000000000000000000000";

    fn catalog(entries: serde_json::Value) -> ModelCatalog {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "whisper_models": entries,
            "llm_models": [],
        }))
        .expect("test catalog parses")
    }

    fn whisper(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "name": id, "repo": format!("org/{id}"),
            "files": ["model.bin", "config.json"], "total_size_bytes": 10,
            "sha256": {"model.bin": H}, "profiles": ["lite"],
            "license": "MIT", "license_url": "https://example.com",
        })
    }

    fn qwen(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "name": id, "repo": format!("Qwen/{id}"),
            "files": ["config.json", "model.safetensors"], "total_size_bytes": 20,
            "sha256": {"config.json": H, "model.safetensors": H}, "profiles": ["power"],
            "license": "Apache-2.0", "license_url": "https://example.com",
            "engine": "qwen3-asr", "requires": ["qwen-aligner"],
            "languages": ["ko", "en"], "min_vram_mb": 6144,
        })
    }

    fn aligner() -> serde_json::Value {
        serde_json::json!({
            "id": "qwen-aligner", "name": "aligner", "repo": "Qwen/aligner",
            "files": ["model.safetensors"], "total_size_bytes": 5,
            "sha256": {"model.safetensors": H}, "profiles": ["power"],
            "license": "Apache-2.0", "license_url": "https://example.com",
            "engine": "qwen3-asr", "role": "aligner",
        })
    }

    fn full() -> ModelCatalog {
        catalog(serde_json::json!([whisper("whisper-small"), qwen("qwen-1.7b"), qwen("qwen-0.6b"), aligner()]))
    }

    #[test]
    fn whisper_entries_default_to_the_old_meaning() {
        let c = catalog(serde_json::json!([whisper("whisper-small")]));
        let e = &c.whisper_models[0];
        assert_eq!(e.engine, crate::state::SttEngine::FasterWhisper);
        assert_eq!(e.role, SttRole::Stt);
        assert!(e.requires.is_empty());
        assert!(e.languages.is_none());
        assert!(e.min_vram_mb.is_none());
    }

    #[test]
    fn unknown_engine_fails_to_parse() {
        let mut bad = whisper("x");
        bad["engine"] = "vosk".into();
        let r: Result<ModelCatalog, _> = serde_json::from_value(serde_json::json!({
            "version": 1, "whisper_models": [bad], "llm_models": [],
        }));
        assert!(r.is_err());
    }

    #[test]
    fn engine_ids_match_the_python_registry() {
        assert_eq!(crate::state::SttEngine::FasterWhisper.as_str(), "faster-whisper");
        assert_eq!(crate::state::SttEngine::Qwen3Asr.as_str(), "qwen3-asr");
    }

    #[test]
    fn representative_hash_prefers_model_bin_then_first_file() {
        let c = full();
        let mut w = find(&c, "whisper-small").unwrap().clone();
        w.sha256.insert("model.bin".into(), "b".repeat(64));
        w.sha256.insert("a.json".into(), "a".repeat(64));
        assert_eq!(representative_hash(&w), "b".repeat(64));

        let mut q = find(&c, "qwen-1.7b").unwrap().clone();
        q.sha256.insert("config.json".into(), "c".repeat(64));
        assert_eq!(representative_hash(&q), "c".repeat(64));
    }

    #[test]
    fn plan_pulls_in_a_missing_aligner_first() {
        let c = full();
        let plan = download_plan(&c, "qwen-1.7b", |_| false).unwrap();
        let ids: Vec<&str> = plan.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["qwen-aligner", "qwen-1.7b"]);
    }

    #[test]
    fn plan_skips_an_installed_aligner() {
        let c = full();
        let plan = download_plan(&c, "qwen-0.6b", |id| id == "qwen-aligner").unwrap();
        let ids: Vec<&str> = plan.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["qwen-0.6b"]);
    }

    #[test]
    fn plan_for_whisper_is_just_the_model() {
        let c = full();
        let plan = download_plan(&c, "whisper-small", |_| false).unwrap();
        assert_eq!(plan.len(), 1);
    }

    #[test]
    fn plan_rejects_unknown_models_and_dangling_requires() {
        let c = full();
        assert!(download_plan(&c, "nope", |_| false).is_err());
        let broken = catalog(serde_json::json!([qwen("qwen-1.7b")]));
        let err = download_plan(&broken, "qwen-1.7b", |_| false).unwrap_err();
        assert!(err.to_string().contains("qwen-aligner"), "{err}");
    }

    #[test]
    fn deleting_the_last_qwen_model_frees_the_aligner() {
        let c = full();
        let installed = vec!["qwen-1.7b".to_string(), "qwen-aligner".to_string(), "whisper-small".to_string()];
        assert_eq!(orphaned_helpers(&c, &installed, "qwen-1.7b"), ["qwen-aligner"]);
    }

    #[test]
    fn the_aligner_stays_while_another_qwen_model_needs_it() {
        let c = full();
        let installed = vec!["qwen-1.7b".into(), "qwen-0.6b".into(), "qwen-aligner".into()];
        assert!(orphaned_helpers(&c, &installed, "qwen-1.7b").is_empty());
    }

    #[test]
    fn deleting_whisper_or_an_unknown_model_frees_nothing() {
        let c = full();
        let installed = vec!["whisper-small".into(), "qwen-aligner".into()];
        assert!(orphaned_helpers(&c, &installed, "whisper-small").is_empty());
        assert!(orphaned_helpers(&c, &installed, "gone-from-catalog").is_empty());
    }

    #[test]
    fn an_aligner_that_is_not_installed_is_not_reported() {
        let c = full();
        let installed = vec!["qwen-1.7b".into()];
        assert!(orphaned_helpers(&c, &installed, "qwen-1.7b").is_empty());
    }

    #[test]
    fn the_engine_is_unused_once_its_last_model_goes() {
        use crate::state::SttEngine::Qwen3Asr;
        let c = full();
        let two = vec!["qwen-1.7b".to_string(), "qwen-0.6b".into(), "qwen-aligner".into(), "whisper-small".into()];
        assert!(engine_still_used(&c, &two, "qwen-1.7b", Qwen3Asr));
        // The aligner alone does not keep the engine "in use".
        let one = vec!["qwen-1.7b".to_string(), "qwen-aligner".into(), "whisper-small".into()];
        assert!(!engine_still_used(&c, &one, "qwen-1.7b", Qwen3Asr));
    }

    #[test]
    fn verify_checks_every_hashed_file_sorted() {
        let c = full();
        let files = files_to_verify(find(&c, "qwen-1.7b").unwrap());
        let names: Vec<&str> = files.iter().map(|(f, _)| f.as_str()).collect();
        assert_eq!(names, ["config.json", "model.safetensors"]);
        let w = files_to_verify(find(&c, "whisper-small").unwrap());
        assert_eq!(w.len(), 1, "Whisper entries still pin model.bin only");
    }

    #[test]
    fn request_extras_name_the_engine_and_aligner() {
        let c = full();
        let (engine, aux) = stt_request_extras(Some(&c), "qwen-0.6b");
        assert_eq!(engine, "qwen3-asr");
        assert_eq!(aux.get("aligner").map(String::as_str), Some("qwen-aligner"));

        let (engine, aux) = stt_request_extras(Some(&c), "whisper-small");
        assert_eq!(engine, "faster-whisper");
        assert!(aux.is_empty());
    }

    #[test]
    fn request_extras_default_when_the_catalog_is_unavailable() {
        let (engine, aux) = stt_request_extras(None, "qwen-0.6b");
        assert_eq!(engine, "faster-whisper");
        assert!(aux.is_empty());
        let c = full();
        assert_eq!(stt_request_extras(Some(&c), "custom-model").0, "faster-whisper");
    }

    #[test]
    fn validate_accepts_a_well_formed_catalog() {
        assert_eq!(validate(&full()), Ok(()));
    }

    #[test]
    fn validate_rejects_unpinned_qwen_files() {
        let mut q = qwen("qwen-1.7b");
        q["sha256"] = serde_json::json!({"config.json": H});
        let err = validate(&catalog(serde_json::json!([q, aligner()]))).unwrap_err();
        assert!(err.contains("model.safetensors"), "{err}");
    }

    #[test]
    fn validate_rejects_bad_requires() {
        let mut q = qwen("qwen-1.7b");
        q["requires"] = serde_json::json!(["whisper-small"]);
        let err = validate(&catalog(serde_json::json!([q, whisper("whisper-small")]))).unwrap_err();
        assert!(err.contains("not an aligner"), "{err}");

        let mut a = aligner();
        a["requires"] = serde_json::json!(["qwen-1.7b"]);
        let err = validate(&catalog(serde_json::json!([qwen("qwen-1.7b"), a]))).unwrap_err();
        assert!(err.contains("cannot require"), "{err}");

        let mut w = whisper("whisper-small");
        w["sha256"] = serde_json::json!({"ghost.bin": H});
        let err = validate(&catalog(serde_json::json!([w]))).unwrap_err();
        assert!(err.contains("ghost.bin"), "{err}");
    }

    #[test]
    fn the_aligner_is_never_a_job_model() {
        let catalog: ModelCatalog =
            serde_json::from_str(include_str!("../resources/model_catalog.json")).unwrap();
        assert!(!is_selectable(&catalog, "qwen3-forced-aligner-0.6b"));
        assert!(is_selectable(&catalog, "qwen3-asr-0.6b"));
        assert!(is_selectable(&catalog, "whisper-small"));
        assert!(is_selectable(&catalog, "not-in-catalog"));
    }

    #[test]
    fn bundled_catalog_satisfies_the_stt_rules() {
        let raw = include_str!("../resources/model_catalog.json");
        let catalog: ModelCatalog = serde_json::from_str(raw).expect("bundled catalog parses");
        assert_eq!(validate(&catalog), Ok(()));
    }
}
