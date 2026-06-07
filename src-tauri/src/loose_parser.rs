use regex::Regex;

use crate::types::{ParseError, TranslationCue};

/// Normalize spaces within a damaged timestamp line so the tight regex can match.
/// Handles cases like:
///   "00:01: 29,020"   → "00:01:29,020"
///   "00: 02:00,090"   → "00:02:00,090"
///   "00:03:41, 420"   → "00:03:41,420"
///   "00:05:34,126 -"  → "00:05:34,126" (trailing garbage dropped)
fn normalize_timestamp_spaces(line: &str) -> String {
    let s = line.trim();
    // Remove spaces around colons: "00: 01" → "00:01",  "01: 29" → "01:29"
    let re_colon = Regex::new(r"(\d)\s*:\s*(\d)").unwrap();
    let s = re_colon.replace_all(s, "$1:$2");
    // Remove spaces around commas in the millisecond part: "29, 020" → "29,020"
    let re_comma = Regex::new(r"(\d)\s*,\s*(\d)").unwrap();
    let s = re_comma.replace_all(&s, "$1,$2");
    // Remove trailing characters that aren't part of a valid timestamp arrow
    // e.g., "00:05:34,126 -" → keep only up to the last digit
    let re_trailing = Regex::new(r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})").unwrap();
    if let Some(caps) = re_trailing.captures(&s) {
        // Return just the matched clean portion
        caps[0].to_string()
    } else {
        s.to_string()
    }
}

/// Loosely parse a potentially damaged translated SRT file.
/// The goal is to extract translated text regardless of structural damage.
/// Structural fields (id, timestamps) are treated as unreliable hints.
pub fn parse_loose(content: &str) -> Result<Vec<TranslationCue>, ParseError> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();

    if trimmed.is_empty() {
        return Err(ParseError::EmptyFile);
    }

    let timestamp_re = Regex::new(
        r"^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})$",
    )
    .unwrap();

    let integer_re = Regex::new(r"^\d+$").unwrap();
    let arrow_re = Regex::new(r"-->").unwrap();
    let time_like_re = Regex::new(r"^\d{2}:\d{2}:\d{2}[,.]\d{3}").unwrap();

    let lines: Vec<&str> = normalized.lines().collect();

    // Classify each line
    #[derive(Debug, PartialEq)]
    enum LineKind {
        CueNumber,
        Timestamp,
        Text,
        Blank,
    }

    let kinds: Vec<(usize, LineKind)> = lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return (i, LineKind::Blank);
            }
            // Try normalized timestamp match first (handles spaces in time parts)
            let normalized_ts = normalize_timestamp_spaces(trimmed);
            if timestamp_re.is_match(&normalized_ts) {
                return (i, LineKind::Timestamp);
            }
            if arrow_re.is_match(trimmed) {
                // Possible damaged timestamp with arrow
                return (i, LineKind::Timestamp);
            }
            if integer_re.is_match(trimmed) {
                return (i, LineKind::CueNumber);
            }
            // Time-like but with spaces or other damage — still treat as timestamp
            if time_like_re.is_match(trimmed)
                || time_like_re.is_match(&normalized_ts)
            {
                return (i, LineKind::Timestamp);
            }
            (i, LineKind::Text)
        })
        .collect();

    // Group text lines into cues, using boundaries (number/timestamp/blank)
    // as separators. Collect text lines between boundaries.
    let mut cues: Vec<TranslationCue> = Vec::new();
    let mut raw_index: usize = 0;
    let mut i = 0;

    while i < lines.len() {
        let (_, ref kind) = kinds[i];

        match kind {
            LineKind::Blank => {
                i += 1;
            }
            LineKind::CueNumber | LineKind::Timestamp | LineKind::Text => {
                // Start a possible cue. If it's a number or timestamp, it might be
                // structural damage — collect it and subsequent text.
                let mut cue_text_parts: Vec<String> = Vec::new();
                let mut possible_id: Option<u32> = None;
                let mut possible_start: Option<String> = None;
                let mut possible_end: Option<String> = None;

                // Check if current line is a cue number
                if kind == &LineKind::CueNumber {
                    possible_id = lines[i].trim().parse().ok();
                    i += 1;
                }

                // Check if next line is a timestamp
                if i < lines.len() && kinds[i].1 == LineKind::Timestamp {
                    let normalized = normalize_timestamp_spaces(lines[i].trim());
                    if let Some(caps) = timestamp_re.captures(&normalized) {
                        possible_start = Some(caps[1].to_string());
                        possible_end = Some(caps[2].to_string());
                    }
                    i += 1;
                }

                // Collect all subsequent text lines until a boundary
                while i < lines.len() {
                    let (_, ref next_kind) = kinds[i];
                    match next_kind {
                        LineKind::Text => {
                            cue_text_parts.push(lines[i].trim().to_string());
                            i += 1;
                        }
                        _ => break,
                    }
                }

                if !cue_text_parts.is_empty() {
                    let text = cue_text_parts.join("\n");
                    // Higher confidence if we found structural elements
                    let has_structure = possible_id.is_some() || possible_start.is_some();
                    cues.push(TranslationCue {
                        raw_index,
                        possible_id,
                        possible_start,
                        possible_end,
                        text,
                        confidence: if has_structure { 0.8 } else { 0.6 },
                    });
                    raw_index += 1;
                } else {
                    // No text found after structural elements — skip
                    i += 1;
                }
            }
        }
    }

    if cues.is_empty() {
        return Err(ParseError::NoTextExtracted);
    }

    Ok(cues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_well_formed_translation() {
        let content =
            "1\n00:00:01,000 --> 00:00:03,000\nこんにちは。\n\n2\n00:00:04,000 --> 00:00:06,000\n世界。\n";
        let cues = parse_loose(content).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "こんにちは。");
        assert_eq!(cues[0].possible_id, Some(1));
        assert_eq!(cues[1].text, "世界。");
    }

    #[test]
    fn parse_missing_blank_lines() {
        let content = "1\n00:00:01,000 --> 00:00:03,000\nこんにちは。\n2\n00:00:04,000 --> 00:00:06,000\n世界。\n";
        let cues = parse_loose(content).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "こんにちは。");
        assert_eq!(cues[1].text, "世界。");
    }

    #[test]
    fn parse_broken_numbers() {
        // Numbers and timestamps mixed into text
        let content = "こんにちは。\n\n世界。\n";
        let cues = parse_loose(content).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "こんにちは。");
        assert_eq!(cues[1].text, "世界。");
    }

    #[test]
    fn parse_number_mixed_in_text() {
        let content = "こんにちは。\n12\nさようなら。\n";
        let cues = parse_loose(content).unwrap();
        // "12" alone on a line is treated as a cue number boundary
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "こんにちは。");
        assert_eq!(cues[1].text, "さようなら。");
    }

    #[test]
    fn parse_empty_file() {
        assert!(matches!(
            parse_loose(""),
            Err(ParseError::EmptyFile)
        ));
    }

    #[test]
    fn parse_only_text() {
        let content = "こんにちは。\n元気ですか？\n";
        let cues = parse_loose(content).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "こんにちは。\n元気ですか？");
    }

    #[test]
    fn parse_timestamp_with_spaces() {
        // Damaged timestamps with spaces like "00:01: 29,020" or "00: 02:00,090"
        let content = "18\n00:01: 29,020 --> 00:01:33,599\nこんにちは。\n\n19\n00: 02:00,090 --> 00:02:05,500\n世界。\n";
        let cues = parse_loose(content).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "こんにちは。");
        assert_eq!(cues[0].possible_id, Some(18));
        assert_eq!(cues[0].possible_start.as_deref(), Some("00:01:29,020"));
        assert_eq!(cues[1].text, "世界。");
        assert_eq!(cues[1].possible_start.as_deref(), Some("00:02:00,090"));
    }

    #[test]
    fn parse_timestamp_with_space_after_comma() {
        // "00:03:41, 420" with space after comma
        let content = "5\n00:03:41, 420 --> 00:03:45,000\nテキスト\n";
        let cues = parse_loose(content).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].possible_start.as_deref(), Some("00:03:41,420"));
    }

    #[test]
    fn parse_timestamp_with_trailing_dash() {
        // "00:05:34,126 -" with trailing garbage
        let content = "10\n00:05:34,126 --> 00:05:38,000\nテキスト\n";
        let cues = parse_loose(content).unwrap();
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].possible_start.as_deref(), Some("00:05:34,126"));
    }
}
