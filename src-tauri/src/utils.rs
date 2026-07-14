use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::AppError;

pub const APP_ID: &str = "LocalSub";

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// Read a JSON file we own, tolerating a UTF-8 BOM.
///
/// `serde_json` rejects a BOM — it is not JSON — and reports it as
/// `expected value at line 1 column 1`, which points at a line that looks
/// perfectly fine in an editor. Yet the Windows tools most likely to touch
/// these files write one: PowerShell 5.1's `Set-Content -Encoding UTF8` and
/// Notepad's "UTF-8 with BOM" both do. We hit this ourselves and spent the
/// debugging budget on a toast that only said "failed to save preset".
///
/// UTF-16 (PowerShell's default `>` redirection) is *not* silently decoded:
/// it fails with a message naming the encoding, because guessing at text
/// encodings is how you corrupt someone's glossary.
pub fn read_json_file<T: DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let bytes = fs::read(path)
        .map_err(|e| AppError::Config(format!("Failed to read {}: {}", path.display(), e)))?;

    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(AppError::Config(format!(
            "{} is UTF-16 encoded; LocalSub reads JSON as UTF-8. \
             Re-save the file as UTF-8 (PowerShell: `Set-Content -Encoding utf8NoBOM`).",
            path.display()
        )));
    }

    let body = bytes.strip_prefix(&UTF8_BOM).unwrap_or(&bytes);

    let text = std::str::from_utf8(body).map_err(|e| {
        AppError::Config(format!(
            "{} is not valid UTF-8 ({}). Re-save the file as UTF-8.",
            path.display(),
            e
        ))
    })?;

    serde_json::from_str(text).map_err(|e| {
        AppError::Config(format!(
            "{}:{}:{}: {}",
            path.display(),
            e.line(),
            e.column(),
            e
        ))
    })
}

/// Build a `Command` that never flashes a console window on Windows.
///
/// Spawning a child process from a GUI app pops a transient black console
/// window unless `CREATE_NO_WINDOW` is set. We poll `nvidia-smi` up to ~20
/// times (once per second) during the VRAM-cleanup restart, so without this
/// the app visibly flickers on every model swap.
pub fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn app_data_dir() -> Result<PathBuf, AppError> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Config("Cannot determine app data directory".into()))?;
    Ok(base.join(APP_ID))
}

pub fn atomic_write<T: Serialize + ?Sized>(path: &Path, data: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Config(format!("Failed to create directory: {}", e)))?;
    }

    let tmp_path = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(data)
        .map_err(|e| AppError::Config(format!("Failed to serialize: {}", e)))?;

    fs::write(&tmp_path, &json)
        .map_err(|e| AppError::Config(format!("Failed to write tmp file: {}", e)))?;

    fs::rename(&tmp_path, path)
        .map_err(|e| AppError::Config(format!("Failed to rename tmp to final: {}", e)))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_id_value() {
        assert_eq!(APP_ID, "LocalSub");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("localsub_read_json_test");
        fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[derive(serde::Deserialize, PartialEq, Debug)]
    struct Doc {
        name: String,
    }

    #[test]
    fn read_json_file_accepts_plain_utf8() {
        let p = scratch("plain.json");
        fs::write(&p, br#"{"name":"ok"}"#).unwrap();
        let doc: Doc = read_json_file(&p).unwrap();
        assert_eq!(doc.name, "ok");
    }

    /// The regression. `Set-Content -Encoding UTF8` prepends EF BB BF, and a
    /// preset file written that way bricked every save with an error that named
    /// neither the file nor the BOM.
    #[test]
    fn read_json_file_tolerates_a_utf8_bom() {
        let p = scratch("bom.json");
        let mut bytes = UTF8_BOM.to_vec();
        bytes.extend_from_slice(br#"{"name":"bom"}"#);
        fs::write(&p, &bytes).unwrap();

        assert!(
            serde_json::from_slice::<Doc>(&bytes).is_err(),
            "if serde_json ever accepts a BOM this test is guarding nothing"
        );

        let doc: Doc = read_json_file(&p).unwrap();
        assert_eq!(doc.name, "bom");
    }

    #[test]
    fn read_json_file_names_the_encoding_when_given_utf16() {
        let p = scratch("utf16.json");
        let mut bytes = vec![0xFF, 0xFE];
        for b in br#"{"name":"x"}"# {
            bytes.push(*b);
            bytes.push(0);
        }
        fs::write(&p, &bytes).unwrap();

        let err = read_json_file::<Doc>(&p).unwrap_err().to_string();
        assert!(err.contains("UTF-16"), "{err}");
        assert!(err.contains("utf16.json"), "{err}");
    }

    /// A parse error must say where. "expected value at line 1 column 1" with no
    /// filename is what sent us hunting through the wrong file.
    #[test]
    fn read_json_file_reports_path_line_and_column() {
        let p = scratch("broken.json");
        fs::write(&p, "{\n  \"name\": ,\n}").unwrap();

        let err = read_json_file::<Doc>(&p).unwrap_err().to_string();
        assert!(err.contains("broken.json"), "{err}");
        assert!(err.contains(":2:"), "expected line 2 in {err}");
    }

    #[test]
    fn read_json_file_rejects_invalid_utf8_without_panicking() {
        let p = scratch("latin1.json");
        fs::write(&p, [b'{', 0xFF, b'}']).unwrap();

        let err = read_json_file::<Doc>(&p).unwrap_err().to_string();
        assert!(err.contains("not valid UTF-8"), "{err}");
    }

    #[test]
    fn test_atomic_write_roundtrip() {
        let dir = std::env::temp_dir().join("localsub_utils_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("test_data.json");
        let data = serde_json::json!({"key": "value", "num": 42});
        atomic_write(&path, &data).unwrap();

        assert!(path.exists());
        assert!(!path.with_extension("tmp").exists());

        let content = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["key"], "value");
        assert_eq!(parsed["num"], 42);

        let _ = fs::remove_dir_all(&dir);
    }
}
