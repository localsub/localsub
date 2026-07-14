use serde::{Deserialize, Serialize};

/// A subtitle segment shared across STT, translate, and export modules.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleSegment {
    pub index: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub translated: Option<String>,
    #[serde(default)]
    pub speaker: Option<String>,
}
