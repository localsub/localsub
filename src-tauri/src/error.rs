use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Python server error: {0}")]
    PythonServer(String),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("Job not found: {0}")]
    JobNotFound(String),

    #[error("Invalid state: {0}")]
    InvalidState(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Setup error: {0}")]
    Setup(String),

    #[error("Config error: {0}")]
    Config(String),

    #[error("Hardware detection error: {0}")]
    Hardware(String),

    #[error("Download error: {0}")]
    Download(String),

    #[error("Subtitle parse error: {0}")]
    SubtitleParse(String),

    #[error("Export error: {0}")]
    Export(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_messages() {
        let e = AppError::PythonServer("conn refused".into());
        assert_eq!(e.to_string(), "Python server error: conn refused");

        let e = AppError::JobNotFound("abc".into());
        assert_eq!(e.to_string(), "Job not found: abc");

        let e = AppError::InvalidState("bad".into());
        assert_eq!(e.to_string(), "Invalid state: bad");

        let e = AppError::Setup("missing pip".into());
        assert_eq!(e.to_string(), "Setup error: missing pip");

        let e = AppError::Config("parse fail".into());
        assert_eq!(e.to_string(), "Config error: parse fail");

        let e = AppError::Hardware("no gpu".into());
        assert_eq!(e.to_string(), "Hardware detection error: no gpu");

        let e = AppError::Download("timeout".into());
        assert_eq!(e.to_string(), "Download error: timeout");
    }

    #[test]
    fn test_error_serializes_as_string() {
        let e = AppError::JobNotFound("xyz".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#""Job not found: xyz""#);

        let e = AppError::Config("bad json".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#""Config error: bad json""#);
    }
}
