use std::fs;
use std::path::Path;

use crate::contracts::SubtitleSegment;

// ── Timestamp helpers ────────────────────────────────────────────

/// SRT format: "00:01:23,456"
fn ts_srt(secs: f64) -> String {
    let h = (secs / 3600.0) as u32;
    let m = ((secs % 3600.0) / 60.0) as u32;
    let s = (secs % 60.0) as u32;
    let ms = ((secs % 1.0) * 1000.0).round() as u32;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

/// VTT format: "00:01:23.456"
fn ts_vtt(secs: f64) -> String {
    let h = (secs / 3600.0) as u32;
    let m = ((secs % 3600.0) / 60.0) as u32;
    let s = (secs % 60.0) as u32;
    let ms = ((secs % 1.0) * 1000.0).round() as u32;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

/// ASS format: "0:01:23.45" (centiseconds)
fn ts_ass(secs: f64) -> String {
    let h = (secs / 3600.0) as u32;
    let m = ((secs % 3600.0) / 60.0) as u32;
    let s = (secs % 60.0) as u32;
    let cs = ((secs % 1.0) * 100.0).round() as u32;
    format!("{}:{:02}:{:02}.{:02}", h, m, s, cs)
}

// ── Formatters ───────────────────────────────────────────────────

fn speaker_prefix(seg: &SubtitleSegment) -> String {
    match seg.speaker {
        Some(ref s) if !s.is_empty() => format!("[{}] ", s),
        _ => String::new(),
    }
}

pub fn format_srt(segments: &[SubtitleSegment]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for (i, seg) in segments.iter().enumerate() {
        let idx = i + 1;
        let start = ts_srt(seg.start);
        let end = ts_srt(seg.end);
        let prefix = speaker_prefix(seg);
        let mut text = format!("{}{}", prefix, seg.text.trim());
        if let Some(ref tr) = seg.translated {
            let tr = tr.trim();
            if !tr.is_empty() {
                text = format!("{}\n{}", text, tr);
            }
        }
        lines.push(format!("{}\n{} --> {}\n{}\n", idx, start, end, text));
    }
    lines.join("\n")
}

pub fn format_vtt(segments: &[SubtitleSegment]) -> String {
    let mut lines: Vec<String> = vec!["WEBVTT".to_string(), String::new()];
    for (i, seg) in segments.iter().enumerate() {
        let idx = i + 1;
        let start = ts_vtt(seg.start);
        let end = ts_vtt(seg.end);
        let prefix = speaker_prefix(seg);
        let mut text = format!("{}{}", prefix, seg.text.trim());
        if let Some(ref tr) = seg.translated {
            let tr = tr.trim();
            if !tr.is_empty() {
                text = format!("{}\n{}", text, tr);
            }
        }
        lines.push(format!("{}\n{} --> {}\n{}\n", idx, start, end, text));
    }
    lines.join("\n")
}

pub fn format_ass(segments: &[SubtitleSegment]) -> String {
    let header = "[Script Info]\n\
        Title: LocalSub Export\n\
        ScriptType: v4.00+\n\
        PlayResX: 1920\n\
        PlayResY: 1080\n\
        \n\
        [V4+ Styles]\n\
        Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, \
        OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, \
        ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, \
        Alignment, MarginL, MarginR, MarginV, Encoding\n\
        Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,\
        0,0,0,0,100,100,0,0,1,2,1,2,10,10,30,1\n\
        \n\
        [Events]\n\
        Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

    let mut lines: Vec<String> = vec![header.to_string()];
    for seg in segments {
        let start = ts_ass(seg.start);
        let end = ts_ass(seg.end);
        let name = seg.speaker.as_deref().unwrap_or("");
        let mut text = seg.text.trim().replace('\n', "\\N");
        if let Some(ref tr) = seg.translated {
            let tr = tr.trim().replace('\n', "\\N");
            if !tr.is_empty() {
                text = format!("{}\\N{}", text, tr);
            }
        }
        lines.push(format!(
            "Dialogue: 0,{},{},Default,{},0,0,0,,{}",
            start, end, name, text
        ));
    }
    lines.join("\n")
}

pub fn format_txt(segments: &[SubtitleSegment]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for seg in segments {
        let prefix = speaker_prefix(seg);
        lines.push(format!("{}{}", prefix, seg.text.trim()));
        if let Some(ref tr) = seg.translated {
            let tr = tr.trim();
            if !tr.is_empty() {
                lines.push(tr.to_string());
            }
        }
    }
    lines.join("\n")
}

/// Unified entry point — dispatches to format-specific function.
pub fn format_subtitles(segments: &[SubtitleSegment], fmt: &str) -> String {
    match fmt.to_lowercase().as_str() {
        "vtt" => format_vtt(segments),
        "ass" => format_ass(segments),
        "txt" => format_txt(segments),
        _ => format_srt(segments),
    }
}

/// Write subtitle content to file. Creates parent dirs if needed.
pub fn write_subtitle_file(content: &str, path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // UTF-8 BOM for Windows compatibility (Korean subtitles in Notepad)
    let bom = "\u{FEFF}";
    fs::write(path, format!("{}{}", bom, content))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_segments() -> Vec<SubtitleSegment> {
        vec![
            SubtitleSegment {
                index: 0,
                start: 0.0,
                end: 2.5,
                text: "Hello world".to_string(),
                translated: Some("안녕하세요".to_string()),
                speaker: None,
            },
            SubtitleSegment {
                index: 1,
                start: 3.0,
                end: 5.0,
                text: "Goodbye".to_string(),
                translated: None,
                speaker: None,
            },
        ]
    }

    #[test]
    fn test_ts_srt() {
        assert_eq!(ts_srt(83.456), "00:01:23,456");
        assert_eq!(ts_srt(0.0), "00:00:00,000");
        assert_eq!(ts_srt(3661.1), "01:01:01,100");
    }

    #[test]
    fn test_ts_vtt() {
        assert_eq!(ts_vtt(83.456), "00:01:23.456");
    }

    #[test]
    fn test_ts_ass() {
        assert_eq!(ts_ass(83.45), "0:01:23.45");
    }

    #[test]
    fn test_format_srt_dual() {
        let srt = format_srt(&sample_segments());
        assert!(srt.contains("1\n00:00:00,000 --> 00:00:02,500\nHello world\n안녕하세요"));
        assert!(srt.contains("2\n00:00:03,000 --> 00:00:05,000\nGoodbye"));
    }

    #[test]
    fn test_format_vtt_header() {
        let vtt = format_vtt(&sample_segments());
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:00.000 --> 00:00:02.500"));
    }

    #[test]
    fn test_format_ass_dialogue() {
        let ass = format_ass(&sample_segments());
        assert!(ass.contains("[Script Info]"));
        assert!(ass.contains("Dialogue: 0,0:00:00.00,0:00:02.50,Default,,0,0,0,,Hello world\\N안녕하세요"), "ASS dialogue line not found in:\n{}", ass);
    }

    #[test]
    fn test_format_txt() {
        let txt = format_txt(&sample_segments());
        assert!(txt.contains("Hello world"));
        assert!(txt.contains("안녕하세요"));
        assert!(txt.contains("Goodbye"));
    }

    #[test]
    fn test_format_subtitles_dispatch() {
        let segs = sample_segments();
        assert!(format_subtitles(&segs, "srt").contains("-->"));
        assert!(format_subtitles(&segs, "VTT").starts_with("WEBVTT"));
        assert!(format_subtitles(&segs, "ASS").contains("[Script Info]"));
        assert!(!format_subtitles(&segs, "txt").contains("-->"));
    }

    fn sample_segments_with_speaker() -> Vec<SubtitleSegment> {
        vec![
            SubtitleSegment {
                index: 0,
                start: 0.0,
                end: 2.5,
                text: "Hello world".to_string(),
                translated: Some("안녕하세요".to_string()),
                speaker: Some("SPEAKER_0".to_string()),
            },
            SubtitleSegment {
                index: 1,
                start: 3.0,
                end: 5.0,
                text: "Goodbye".to_string(),
                translated: None,
                speaker: Some("SPEAKER_1".to_string()),
            },
            SubtitleSegment {
                index: 2,
                start: 6.0,
                end: 8.0,
                text: "No speaker".to_string(),
                translated: None,
                speaker: None,
            },
        ]
    }

    #[test]
    fn test_format_srt_with_speaker() {
        let srt = format_srt(&sample_segments_with_speaker());
        assert!(srt.contains("[SPEAKER_0] Hello world"), "SRT should prefix with speaker label:\n{}", srt);
        assert!(srt.contains("[SPEAKER_1] Goodbye"), "SRT should prefix second speaker:\n{}", srt);
        assert!(srt.contains("No speaker"), "SRT should show text without prefix when no speaker");
        assert!(!srt.contains("[SPEAKER_") || !srt.contains("[] No speaker"),
            "SRT should not add empty prefix for segments without speaker");
    }

    #[test]
    fn test_format_vtt_with_speaker() {
        let vtt = format_vtt(&sample_segments_with_speaker());
        assert!(vtt.contains("[SPEAKER_0] Hello world"), "VTT should prefix with speaker label");
        assert!(vtt.contains("[SPEAKER_1] Goodbye"), "VTT should prefix second speaker");
    }

    #[test]
    fn test_format_ass_with_speaker() {
        let ass = format_ass(&sample_segments_with_speaker());
        // ASS uses the Name field for speaker
        assert!(ass.contains(",Default,SPEAKER_0,0,0,0,,Hello world"),
            "ASS should put speaker in Name field:\n{}", ass);
        assert!(ass.contains(",Default,SPEAKER_1,0,0,0,,Goodbye"),
            "ASS should put second speaker in Name field:\n{}", ass);
        // No speaker → empty Name field
        assert!(ass.contains(",Default,,0,0,0,,No speaker"),
            "ASS should have empty Name field when no speaker:\n{}", ass);
    }

    #[test]
    fn test_format_txt_with_speaker() {
        let txt = format_txt(&sample_segments_with_speaker());
        assert!(txt.contains("[SPEAKER_0] Hello world"), "TXT should prefix with speaker label");
        assert!(txt.contains("[SPEAKER_1] Goodbye"), "TXT should prefix second speaker");
        // No speaker → no prefix
        let lines: Vec<&str> = txt.lines().collect();
        let no_speaker_line = lines.iter().find(|l| l.contains("No speaker")).unwrap();
        assert!(!no_speaker_line.starts_with('['), "TXT should not prefix when no speaker");
    }

    #[test]
    fn test_speaker_prefix_empty_string() {
        let seg = SubtitleSegment {
            index: 0,
            start: 0.0,
            end: 1.0,
            text: "Test".to_string(),
            translated: None,
            speaker: Some("".to_string()),
        };
        assert_eq!(speaker_prefix(&seg), "", "Empty speaker string should produce no prefix");
    }
}
