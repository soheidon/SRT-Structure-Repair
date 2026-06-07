use regex::Regex;

use crate::types::{ParseError, SourceCue};

/// Strictly parse a well-formed SRT file.
/// Expects proper structure: cue number, timestamp line, text, blank line separator.
pub fn parse_strict(content: &str) -> Result<Vec<SourceCue>, ParseError> {
    // Normalize line endings: CRLF -> LF, then split
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();

    if trimmed.is_empty() {
        return Err(ParseError::EmptyFile);
    }

    // Split into blocks separated by blank lines
    let blocks: Vec<&str> = trimmed
        .split("\n\n")
        .map(|b| b.trim())
        .filter(|b| !b.is_empty())
        .collect();

    if blocks.is_empty() {
        return Err(ParseError::EmptyFile);
    }

    let timestamp_re = Regex::new(
        r"^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})$",
    )
    .unwrap();

    let mut cues = Vec::with_capacity(blocks.len());

    for (index, block) in blocks.iter().enumerate() {
        let lines: Vec<&str> = block.lines().collect();
        // Allow empty cues: a block may have only 2 lines (number + timestamp, no text).
        if lines.len() < 2 {
            return Err(ParseError::InvalidCueNumber {
                line: index + 1,
                found: lines.first().unwrap_or(&"").to_string(),
            });
        }

        // Line 1: cue number
        let id: u32 = lines[0]
            .trim()
            .parse()
            .map_err(|_| ParseError::InvalidCueNumber {
                line: index + 1,
                found: lines[0].to_string(),
            })?;

        // Line 2: timestamp
        let caps = timestamp_re.captures(lines[1].trim()).ok_or_else(|| {
            ParseError::InvalidTimestamp {
                line: index + 1,
                found: lines[1].to_string(),
            }
        })?;

        let start = caps[1].to_string();
        let end = caps[2].to_string();

        // Remaining lines: subtitle text (may be empty for blank cues)
        let text = if lines.len() > 2 {
            lines[2..].join("\n").trim().to_string()
        } else {
            String::new()
        };

        cues.push(SourceCue {
            id,
            index,
            start,
            end,
            text,
        });
    }

    // Validate sequential timestamps
    for i in 1..cues.len() {
        if let (Some(prev_end), Some(cur_start)) =
            (time_to_ms(&cues[i - 1].end), time_to_ms(&cues[i].start))
        {
            if cur_start < prev_end {
                return Err(ParseError::NonSequentialTimestamps {
                    cue_id: cues[i].id,
                });
            }
        }
    }

    Ok(cues)
}

/// Convert "HH:MM:SS,mmm" to milliseconds.
fn time_to_ms(timestamp: &str) -> Option<u64> {
    let parts: Vec<&str> = timestamp.split(|c| c == ':' || c == ',').collect();
    if parts.len() != 4 {
        return None;
    }
    let h: u64 = parts[0].parse().ok()?;
    let m: u64 = parts[1].parse().ok()?;
    let s: u64 = parts[2].parse().ok()?;
    let ms: u64 = parts[3].parse().ok()?;
    Some(h * 3_600_000 + m * 60_000 + s * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_srt() {
        let content = "1\n00:00:01,000 --> 00:00:03,000\nHello.\n\n2\n00:00:04,000 --> 00:00:06,000\nWorld.\n";
        let cues = parse_strict(content).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].id, 1);
        assert_eq!(cues[0].start, "00:00:01,000");
        assert_eq!(cues[0].end, "00:00:03,000");
        assert_eq!(cues[0].text, "Hello.");
        assert_eq!(cues[1].id, 2);
        assert_eq!(cues[1].text, "World.");
    }

    #[test]
    fn parse_multiline_text() {
        let content = "1\n00:00:01,000 --> 00:00:03,000\nLine one\nLine two.\n";
        let cues = parse_strict(content).unwrap();
        assert_eq!(cues[0].text, "Line one\nLine two.");
    }

    #[test]
    fn parse_empty_file() {
        assert!(matches!(
            parse_strict(""),
            Err(ParseError::EmptyFile)
        ));
    }

    #[test]
    fn parse_crlf() {
        let content = "1\r\n00:00:01,000 --> 00:00:03,000\r\nHello.\r\n";
        let cues = parse_strict(content).unwrap();
        assert_eq!(cues[0].text, "Hello.");
    }

    #[test]
    fn parse_invalid_cue_number() {
        let content = "abc\n00:00:01,000 --> 00:00:03,000\nHello.\n";
        assert!(matches!(
            parse_strict(content),
            Err(ParseError::InvalidCueNumber { .. })
        ));
    }

    #[test]
    fn parse_invalid_timestamp() {
        let content = "1\nnot-a-timestamp\nHello.\n";
        assert!(matches!(
            parse_strict(content),
            Err(ParseError::InvalidTimestamp { .. })
        ));
    }

    #[test]
    fn parse_empty_text_cue() {
        // Cue 22 with timestamp but no text, followed by another empty cue, then normal cue
        let content = "21\n00:01:50,020 --> 00:02:00,090\nTiming and Subtitles\n\n22\n00:03:06,620 --> 00:03:13,087\n\n23\n00:03:13,087 --> 00:03:15,807\n\n24\n00:03:21,520 --> 00:03:26,340\nHello.\n";
        let cues = parse_strict(content).unwrap();
        assert_eq!(cues.len(), 4);
        assert_eq!(cues[0].id, 21);
        assert_eq!(cues[0].text, "Timing and Subtitles");
        assert_eq!(cues[1].id, 22);
        assert_eq!(cues[1].text, ""); // empty cue
        assert_eq!(cues[1].start, "00:03:06,620");
        assert_eq!(cues[1].end, "00:03:13,087");
        assert_eq!(cues[2].id, 23);
        assert_eq!(cues[2].text, ""); // empty cue
        assert_eq!(cues[3].id, 24);
        assert_eq!(cues[3].text, "Hello.");
    }

    #[test]
    fn parse_empty_text_with_blank_line() {
        // Cue with number, timestamp, then what looks like an empty text line (blank)
        let content = "1\n00:00:01,000 --> 00:00:03,000\n\n\n2\n00:00:04,000 --> 00:00:06,000\nWorld.\n";
        let cues = parse_strict(content).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "");
        assert_eq!(cues[1].text, "World.");
    }
}
