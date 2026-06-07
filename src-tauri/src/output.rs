use std::path::{Path, PathBuf};

use crate::types::{RepairLogEntry, RepairedCue};

/// Default workspace directory when none is configured.
/// Returns `%USERPROFILE%\Documents\SRTRepair` (Windows) or `~/Documents/SRTRepair`.
pub(crate) fn default_work_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    Path::new(&home).join("Documents").join("SRTRepair")
}

/// Resolve the workspace directory from a config value.
/// If `config_work_dir` is Some and an absolute path, use it.
/// Otherwise fall back to `default_work_dir()`.
pub(crate) fn resolve_work_dir(config_work_dir: Option<&str>) -> PathBuf {
    match config_work_dir {
        Some(dir) if !dir.is_empty() => {
            let p = Path::new(dir);
            if p.is_absolute() {
                return p.to_path_buf();
            }
        }
        _ => {}
    }
    default_work_dir()
}

/// Resolve a workspace subdirectory, creating it if it doesn't exist.
/// e.g. resolve_work_subdir("outputs", work_dir) → {work_dir}/outputs/
fn resolve_work_subdir(subdir: &str, work_dir: &Path) -> PathBuf {
    let path = work_dir.join(subdir);
    let _ = std::fs::create_dir_all(&path);
    path
}

/// Generate an SRT file string from repaired cues.
/// Output format: UTF-8 no BOM, CRLF line endings.
pub fn generate_srt(cues: &[RepairedCue]) -> String {
    let mut output = String::new();

    for (i, cue) in cues.iter().enumerate() {
        output.push_str(&format!("{}\r\n", cue.id));
        output.push_str(&format!("{} --> {}\r\n", cue.start, cue.end));
        output.push_str(&format!("{}\r\n", cue.translated_text));

        // Blank line between cues (but not after the last one)
        if i < cues.len() - 1 {
            output.push_str("\r\n");
        }
    }

    output
}

/// Determine the output file path based on the translated SRT file name.
///
/// Given `episode01.ja.srt`, produces `{work_dir}/outputs/episode01.ja-Repaired.srt`.
/// If that file exists, tries `episode01.ja-Repaired-2.srt`, `-3`, etc.
pub fn determine_output_path(translated_file_name: &str, work_dir: &Path) -> String {
    let parent = resolve_work_subdir("outputs", work_dir);

    let name_path = Path::new(translated_file_name);
    let stem = name_path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = name_path.extension().unwrap_or_default().to_string_lossy();

    let base_name = format!("{}-Repaired", stem);
    let mut candidate = if ext.is_empty() {
        parent.join(&base_name)
    } else {
        parent.join(format!("{}.{}", base_name, ext))
    };

    // If the base name already exists, try incremental suffixes
    if candidate.exists() {
        let mut counter = 2;
        loop {
            let name = if ext.is_empty() {
                format!("{}-{}", base_name, counter)
            } else {
                format!("{}-{}.{}", base_name, counter, ext)
            };
            candidate = parent.join(&name);
            if !candidate.exists() {
                break;
            }
            counter += 1;
        }
    }

    candidate.to_string_lossy().to_string()
}

/// Determine the log file path based on the translated SRT file name.
///
/// Given `episode01.ja.srt`, produces `{work_dir}/logs/episode01.ja-Repaired.log`.
pub fn determine_log_path(translated_file_name: &str, work_dir: &Path) -> String {
    let parent = resolve_work_subdir("logs", work_dir);

    let name_path = Path::new(translated_file_name);
    let stem = name_path.file_stem().unwrap_or_default().to_string_lossy();

    let log_name = format!("{}-Repaired.log", stem);
    parent.join(&log_name).to_string_lossy().to_string()
}

/// Determine the review actions log path based on the translated SRT file name.
///
/// Given `episode01.ja.srt`, produces `{work_dir}/logs/episode01.ja-review-actions.json`.
pub fn determine_review_log_path(translated_file_name: &str, work_dir: &Path) -> String {
    let parent = resolve_work_subdir("logs", work_dir);

    let name_path = Path::new(translated_file_name);
    let stem = name_path.file_stem().unwrap_or_default().to_string_lossy();

    let log_name = format!("{}-review-actions.json", stem);
    parent.join(&log_name).to_string_lossy().to_string()
}

/// Determine the output path for LLM-repaired SRT in an explicit directory.
///
/// Given `episode01.ja.srt`, produces `{output_dir}/episode01.ja-Repaired_after_llm.srt`.
/// If that file exists, tries `episode01.ja-Repaired_after_llm-2.srt`, `-3`, etc.
///
/// If `output_dir` is provided, uses that directory instead of the user's home.
pub fn determine_output_path_llm_in_dir(translated_file_name: &str, output_dir: &str) -> String {
    let parent = Path::new(output_dir);

    let name_path = Path::new(translated_file_name);
    let stem = name_path.file_stem().unwrap_or_default().to_string_lossy();
    let ext = name_path.extension().unwrap_or_default().to_string_lossy();

    let base_name = format!("{}-Repaired_after_llm", stem);
    let mut candidate = if ext.is_empty() {
        parent.join(&base_name)
    } else {
        parent.join(format!("{}.{}", base_name, ext))
    };

    if candidate.exists() {
        let mut counter = 2;
        loop {
            let name = if ext.is_empty() {
                format!("{}-{}", base_name, counter)
            } else {
                format!("{}-{}.{}", base_name, counter, ext)
            };
            candidate = parent.join(&name);
            if !candidate.exists() {
                break;
            }
            counter += 1;
        }
    }

    candidate.to_string_lossy().to_string()
}

/// Determine the output path for LLM-repaired SRT, defaulting to the workspace outputs folder.
pub fn determine_output_path_llm(translated_file_name: &str, work_dir: &Path) -> String {
    let parent = resolve_work_subdir("outputs", work_dir);
    determine_output_path_llm_in_dir(translated_file_name, &parent.to_string_lossy())
}

/// Generate a plain-text repair log.
pub fn generate_log(
    entries: &[RepairLogEntry],
    process_log: &[String],
    original_file_name: &str,
    translated_file_name: &str,
    output_path: &str,
    total_cues: usize,
    auto_matched: usize,
    structure_recovered: usize,
    llm_repaired: usize,
    needs_review: usize,
    unmatched: usize,
) -> String {
    let mut log = String::new();

    log.push_str("SRT Repair Tool Log\r\n");
    log.push_str(&format!("Input original: {}\r\n", original_file_name));
    log.push_str(&format!("Input translated: {}\r\n", translated_file_name));
    log.push_str(&format!("Output: {}\r\n", output_path));
    log.push_str("\r\n");
    log.push_str("Summary:\r\n");
    log.push_str(&format!("Total cues: {}\r\n", total_cues));
    log.push_str(&format!("Auto matched: {}\r\n", auto_matched));
    log.push_str(&format!("Structure recovered: {}\r\n", structure_recovered));
    log.push_str(&format!("LLM repaired: {}\r\n", llm_repaired));
    log.push_str(&format!("Needs review: {}\r\n", needs_review));
    log.push_str(&format!("Unmatched: {}\r\n", unmatched));
    log.push_str("\r\n");

    // Process log: sequential events from the repair run
    if !process_log.is_empty() {
        log.push_str("============================================================\r\n");
        log.push_str("Process Log\r\n");
        log.push_str("============================================================\r\n");
        for line in process_log {
            log.push_str(&format!("{}\r\n", line));
        }
        log.push_str("\r\n");
    }

    for entry in entries {
        log.push_str("------------------------------------------------------------\r\n");
        log.push_str(&format!("Cue #{}\r\n", entry.cue_id));
        log.push_str(&format!("Time: {} --> {}\r\n", entry.start, entry.end));
        log.push_str(&format!("Status: {:?}\r\n", entry.status));

        let issue = if entry.issue.is_empty() {
            "No issue description."
        } else {
            &entry.issue
        };
        log.push_str(&format!("Issue: {}\r\n", issue));
        log.push_str("\r\n");

        log.push_str("[Original English]\r\n");
        log.push_str(&format!("{}\r\n", entry.source_text));
        log.push_str("\r\n");

        log.push_str("[Japanese / Repaired]\r\n");
        log.push_str(&format!("{}\r\n", entry.translated_after));
        log.push_str("\r\n");
    }

    log
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{RepairStatus, RepairedCue};

    #[test]
    fn generate_basic_srt() {
        let cues = vec![RepairedCue {
            id: 1,
            start: "00:00:01,000".to_string(),
            end: "00:00:03,000".to_string(),
            source_text: "Hello.".to_string(),
            translated_text: "こんにちは。".to_string(),
            status: RepairStatus::AutoMatched,
            confidence: 1.0,
            notes: None,
        }];

        let output = generate_srt(&cues);
        assert_eq!(
            output,
            "1\r\n00:00:01,000 --> 00:00:03,000\r\nこんにちは。\r\n"
        );
    }

    #[test]
    fn generate_multiple_cues() {
        let cues = vec![
            RepairedCue {
                id: 1,
                start: "00:00:01,000".to_string(),
                end: "00:00:03,000".to_string(),
                source_text: "Hello.".to_string(),
                translated_text: "こんにちは。".to_string(),
                status: RepairStatus::AutoMatched,
                confidence: 1.0,
                notes: None,
            },
            RepairedCue {
                id: 2,
                start: "00:00:04,000".to_string(),
                end: "00:00:06,000".to_string(),
                source_text: "Goodbye.".to_string(),
                translated_text: "さようなら。".to_string(),
                status: RepairStatus::AutoMatched,
                confidence: 1.0,
                notes: None,
            },
        ];

        let output = generate_srt(&cues);
        assert!(output.contains("\r\n\r\n"));
        assert_eq!(
            output.matches("1\r\n").count(),
            1
        );
    }

    #[test]
    fn output_path_basic() {
        let path = determine_output_path("episode01.ja.srt", &default_work_dir());
        assert!(path.contains("episode01.ja-Repaired.srt"));
    }
}
