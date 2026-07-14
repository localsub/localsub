use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct CsvRow {
    pub source: String,
    pub target: String,
    pub context: Option<String>,
    pub note: Option<String>,
}

/// Parse a CSV file into CsvRow entries.
/// Handles UTF-8 BOM, quoted fields (RFC 4180), and auto-detects header row.
pub fn parse_csv(content: &str) -> Vec<CsvRow> {
    // Strip UTF-8 BOM if present
    let content = content.strip_prefix('\u{FEFF}').unwrap_or(content);

    let mut lines: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_field = String::new();
    let mut in_quotes = false;
    let mut chars = content.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    // Escaped quote
                    current_field.push('"');
                    chars.next();
                } else {
                    // End of quoted field
                    in_quotes = false;
                }
            } else {
                current_field.push(ch);
            }
        } else {
            match ch {
                '"' => {
                    in_quotes = true;
                }
                ',' => {
                    current_row.push(current_field.trim().to_string());
                    current_field = String::new();
                }
                '\n' => {
                    current_row.push(current_field.trim().to_string());
                    current_field = String::new();
                    if !current_row.iter().all(|f| f.is_empty()) {
                        lines.push(current_row);
                    }
                    current_row = Vec::new();
                }
                '\r' => {
                    // Skip carriage return (handled by \n)
                }
                _ => {
                    current_field.push(ch);
                }
            }
        }
    }

    // Flush last field/row
    current_row.push(current_field.trim().to_string());
    if !current_row.iter().all(|f| f.is_empty()) {
        lines.push(current_row);
    }

    if lines.is_empty() {
        return Vec::new();
    }

    // Auto-detect header row: if first row contains "source" or "target" (case-insensitive)
    let first_row_lower: Vec<String> = lines[0].iter().map(|f| f.to_lowercase()).collect();
    let has_header = first_row_lower.iter().any(|f| f == "source" || f == "target");
    let start = if has_header { 1 } else { 0 };

    let mut rows = Vec::new();
    for line in &lines[start..] {
        let source = line.first().map(|s| s.as_str()).unwrap_or("").to_string();
        let target = line.get(1).map(|s| s.as_str()).unwrap_or("").to_string();

        // Skip rows without both source and target
        if source.is_empty() || target.is_empty() {
            continue;
        }

        let context = line.get(2).map(|s| s.as_str()).unwrap_or("");
        let note = line.get(3).map(|s| s.as_str()).unwrap_or("");

        rows.push(CsvRow {
            source,
            target,
            context: if context.is_empty() { None } else { Some(context.to_string()) },
            note: if note.is_empty() { None } else { Some(note.to_string()) },
        });
    }

    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_csv() {
        let csv = "hello,world\nfoo,bar";
        let rows = parse_csv(csv);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].source, "hello");
        assert_eq!(rows[0].target, "world");
    }

    #[test]
    fn test_with_header() {
        let csv = "source,target,context,note\nhello,world,ctx,n";
        let rows = parse_csv(csv);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "hello");
        assert_eq!(rows[0].context, Some("ctx".to_string()));
    }

    #[test]
    fn test_bom() {
        let csv = "\u{FEFF}source,target\nhello,world";
        let rows = parse_csv(csv);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_quoted_fields() {
        let csv = r#""hello, world","target ""quoted""",ctx"#;
        let rows = parse_csv(csv);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "hello, world");
        assert_eq!(rows[0].target, r#"target "quoted""#);
    }

    #[test]
    fn test_skip_incomplete_rows() {
        let csv = "hello,\n,world\ngood,morning";
        let rows = parse_csv(csv);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "good");
    }
}
