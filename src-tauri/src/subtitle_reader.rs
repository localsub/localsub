//! SRT/VTT subtitle file reader for the translate-only import mode.
//!
//! Tolerant by design: missing cue indices, CRLF line endings, HTML tags,
//! and CP949-encoded files (common for Korean subtitles) are all handled.

use std::path::Path;

use crate::contracts::SubtitleSegment;
use crate::error::AppError;

/// Decode raw subtitle bytes: strip BOM, try UTF-8, fall back to CP949 (EUC-KR).
pub fn decode_subtitle_bytes(bytes: &[u8]) -> String {
    // UTF-8 BOM
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(rest).into_owned();
    }
    // UTF-16 BOMs (Windows Notepad "Unicode" saves) — decode explicitly so the
    // EUC-KR fallback never sees them.
    if bytes.starts_with(b"\xFF\xFE") {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return text.into_owned();
    }
    if bytes.starts_with(b"\xFE\xFF") {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return text.into_owned();
    }
    // Valid UTF-8 → take as-is; otherwise assume CP949/EUC-KR (legacy Korean).
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (text, _, _) = encoding_rs::EUC_KR.decode(bytes);
            text.into_owned()
        }
    }
}

/// Parse "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "MM:SS.mmm" into seconds.
fn parse_timestamp(s: &str) -> Option<f64> {
    let s = s.trim();
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    // All parts except the last are whole hours/minutes.
    let mut total = 0.0;
    for part in &parts[..parts.len() - 1] {
        let v: f64 = part.trim().parse().ok()?;
        if !v.is_finite() || v < 0.0 {
            return None;
        }
        total = total * 60.0 + v;
    }
    // Last part is seconds with "," or "." millisecond separator.
    let secs: f64 = parts[parts.len() - 1].trim().replace(',', ".").parse().ok()?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    Some(total * 60.0 + secs)
}

/// Remove `<...>` markup and restore the four common HTML entities.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

/// Parse a "start --> end" cue timing line. The VTT end half may carry cue
/// settings ("00:00:02.000 align:start"), so only its first token is used.
fn parse_timing_line(line: &str) -> Option<(f64, f64)> {
    let (start_raw, end_raw) = line.split_once("-->")?;
    let start = parse_timestamp(start_raw)?;
    let end = parse_timestamp(end_raw.trim().split_whitespace().next()?)?;
    Some((start, end))
}

/// Shared cue-block parser. `blocks` are groups of non-empty lines; within a
/// block the line containing "-->" marks the timing (anything before it — an
/// SRT index or VTT cue identifier — is ignored), and every line after it is
/// cue text, merged with single spaces.
fn parse_blocks<'a>(blocks: impl Iterator<Item = Vec<&'a str>>) -> Vec<SubtitleSegment> {
    let mut segments = Vec::new();
    for block in blocks {
        let Some(timing_pos) = block.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let Some((start, end)) = parse_timing_line(block[timing_pos]) else {
            continue;
        };
        let text = block[timing_pos + 1..]
            .iter()
            .map(|l| strip_tags(l))
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            continue;
        }
        segments.push(SubtitleSegment {
            index: segments.len() as u32,
            start,
            end,
            text,
            translated: None,
            speaker: None,
        });
    }
    segments
}

/// Split content into blocks of consecutive non-empty (trimmed) lines.
fn split_into_blocks(content: &str) -> Vec<Vec<&str>> {
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim_end_matches('\r').trim();
        if trimmed.is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else {
            current.push(trimmed);
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
}

/// Parse SRT content into segments. Err if no valid cues are found.
pub fn parse_srt(content: &str) -> Result<Vec<SubtitleSegment>, AppError> {
    let segments = parse_blocks(split_into_blocks(content).into_iter());
    if segments.is_empty() {
        return Err(AppError::SubtitleParse(
            "no subtitle cues found in SRT content".to_string(),
        ));
    }
    Ok(segments)
}

/// Parse WebVTT content into segments. Err if no valid cues are found.
pub fn parse_vtt(content: &str) -> Result<Vec<SubtitleSegment>, AppError> {
    let blocks = split_into_blocks(content).into_iter().filter(|block| {
        // Skip header/metadata blocks; cue blocks are handled by parse_blocks.
        !block.first().is_some_and(|first| {
            first.starts_with("WEBVTT")
                || first.starts_with("NOTE")
                || first.starts_with("STYLE")
                || first.starts_with("REGION")
        })
    });
    let segments = parse_blocks(blocks);
    if segments.is_empty() {
        return Err(AppError::SubtitleParse(
            "no subtitle cues found in VTT content".to_string(),
        ));
    }
    Ok(segments)
}

/// Read a subtitle file from disk, dispatching by extension (.vtt → VTT, else SRT).
/// Reject absurdly large files before slurping — a mislabeled video would
/// otherwise balloon memory. Real subtitle files are well under this.
const MAX_SUBTITLE_FILE_BYTES: u64 = 50 * 1024 * 1024;

pub fn read_subtitle_file(path: &Path) -> Result<Vec<SubtitleSegment>, AppError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_SUBTITLE_FILE_BYTES {
        return Err(AppError::SubtitleParse(format!(
            "subtitle file too large: {} bytes",
            meta.len()
        )));
    }
    let bytes = std::fs::read(path)?;
    let content = decode_subtitle_bytes(&bytes);
    let is_vtt = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("vtt"));
    if is_vtt {
        parse_vtt(&content)
    } else {
        parse_srt(&content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_srt() {
        let srt = "1\n00:00:01,000 --> 00:00:02,500\n안녕하세요\n\n2\n00:00:03,000 --> 00:00:04,000\n둘째 줄\n첫째 큐의 두 번째 라인\n";
        let segs = parse_srt(srt).unwrap();
        assert_eq!(segs.len(), 2);
        assert!((segs[0].start - 1.0).abs() < 1e-6);
        assert!((segs[0].end - 2.5).abs() < 1e-6);
        assert_eq!(segs[1].text, "둘째 줄 첫째 큐의 두 번째 라인"); // 멀티라인은 공백 병합
    }

    #[test]
    fn tolerates_missing_index_and_crlf() {
        let srt = "00:00:01,000 --> 00:00:02,000\r\nA\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nB\r\n";
        assert_eq!(parse_srt(srt).unwrap().len(), 2);
    }

    #[test]
    fn skips_empty_cues_and_html_tags() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n<i>이탤릭</i>\n\n2\n00:00:03,000 --> 00:00:04,000\n\n";
        let segs = parse_srt(srt).unwrap();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "이탤릭");
    }

    #[test]
    fn parses_vtt_with_header_and_dot_millis() {
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n00:01:03.500 --> 00:01:04.000\nWorld\n";
        let segs = parse_vtt(vtt).unwrap();
        assert_eq!(segs.len(), 2);
        assert!((segs[1].start - 63.5).abs() < 1e-6);
    }

    #[test]
    fn decodes_cp949_fallback() {
        let cp949: Vec<u8> = vec![0xBE, 0xC8, 0xB3, 0xE7]; // "안녕" in CP949
        assert_eq!(decode_subtitle_bytes(&cp949), "안녕");
    }

    #[test]
    fn strips_utf8_bom() {
        let with_bom = [b"\xEF\xBB\xBF".to_vec(), "1\n00:00:01,000 --> 00:00:02,000\nA\n".as_bytes().to_vec()].concat();
        assert!(decode_subtitle_bytes(&with_bom).starts_with('1'));
    }

    #[test]
    fn rejects_file_with_no_cues() {
        assert!(parse_srt("그냥 텍스트 파일").is_err());
    }

    #[test]
    fn roundtrip_with_writer() {
        let srt = "1\n00:00:01,000 --> 00:00:02,500\n안녕하세요\n\n2\n00:00:03,000 --> 00:00:04,000\n둘째\n";
        let segs = parse_srt(srt).unwrap();
        let rewritten = crate::subtitle_writer::format_subtitles(&segs, "srt");
        let reparsed = parse_srt(&rewritten).unwrap();
        assert_eq!(segs.len(), reparsed.len());
        assert_eq!(segs[0].text, reparsed[0].text);
    }
}
