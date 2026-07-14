use std::path::Path;

use crate::contracts::SubtitleSegment;
use crate::error::AppError;
use crate::subtitle_reader;

/// Read and parse an .srt/.vtt file so the frontend can start a
/// translate-only pipeline without running STT.
#[tauri::command]
pub async fn read_subtitle_file(path: String) -> Result<Vec<SubtitleSegment>, AppError> {
    subtitle_reader::read_subtitle_file(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// File-based integration test: UTF-8 (with BOM) and CP949 files on disk
    /// go through the same path the Tauri command uses.
    #[tokio::test]
    async fn reads_utf8_and_cp949_files_from_disk() {
        let dir = std::env::temp_dir().join("localsub_subtitle_import_test");
        std::fs::create_dir_all(&dir).unwrap();

        // UTF-8 with BOM
        let utf8_path = dir.join("utf8.srt");
        let srt = "1\n00:00:01,000 --> 00:00:02,500\n안녕하세요\n\n2\n00:00:03,000 --> 00:00:04,000\n둘째 줄\n";
        std::fs::write(&utf8_path, [b"\xEF\xBB\xBF".to_vec(), srt.as_bytes().to_vec()].concat()).unwrap();

        // CP949 (EUC-KR): "안녕" = BE C8 B3 E7
        let cp949_path = dir.join("cp949.srt");
        let mut cp949_bytes = b"1\r\n00:00:01,000 --> 00:00:02,000\r\n".to_vec();
        cp949_bytes.extend_from_slice(&[0xBE, 0xC8, 0xB3, 0xE7]);
        cp949_bytes.extend_from_slice(b"\r\n\r\n");
        std::fs::write(&cp949_path, cp949_bytes).unwrap();

        let utf8_segs = read_subtitle_file(utf8_path.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(utf8_segs.len(), 2);
        assert_eq!(utf8_segs[0].text, "안녕하세요");
        assert!((utf8_segs[0].start - 1.0).abs() < 1e-6);

        let cp949_segs = read_subtitle_file(cp949_path.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(cp949_segs.len(), 1);
        assert_eq!(cp949_segs[0].text, "안녕");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
