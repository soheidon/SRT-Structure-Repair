use crate::types::{RepairStatus, RepairedCue, SourceCue, TranslationCue};

/// Number of context cues to include before a problem section for LLM repair.
const LLM_CONTEXT_CUES: usize = 10;

/// Result of mechanical repair: successfully repaired cues + problem sections.
pub struct MechanicalRepairResult {
    pub repaired: Vec<RepairedCue>,
    /// Sections that need LLM repair.
    /// Each section includes context cues for the LLM to understand the surrounding text.
    pub problem_sections: Vec<ProblemSection>,
}

pub struct ProblemSection {
    /// Start index in the source cues (inclusive), including context
    pub source_start_idx: usize,
    /// End index in the source cues (exclusive)
    pub source_end_idx: usize,
    /// Start index in the translation cues (inclusive)
    pub translation_start_idx: usize,
    /// End index in the translation cues (exclusive)
    pub translation_end_idx: usize,
    /// The source cue indices that actually need repair (without context)
    pub repair_target_indices: Vec<usize>,
}

/// Perform mechanical repair by matching source cues to translation texts.
///
/// Algorithm:
/// 1. Count comparison — if equal, simple positional mapping (AutoMatched)
/// 2. If counts differ, try extracting only text from translation cues
///    — if extracted count equals source count, StructureRecovered
/// 3. Otherwise, detect localized problem sections and mark them for LLM or NeedsReview
///
/// Problem sections are localized: only the mismatched tail of cues is flagged,
/// never the entire file. Context cues (+10 before) are included for LLM repair.
pub fn mechanical_repair(
    source: &[SourceCue],
    translation: &[TranslationCue],
) -> MechanicalRepairResult {
    let source_count = source.len();
    let translation_count = translation.len();

    if source_count == translation_count {
        let repaired: Vec<RepairedCue> = source
            .iter()
            .zip(translation.iter())
            .map(|(s, t)| RepairedCue {
                id: s.id,
                start: s.start.clone(),
                end: s.end.clone(),
                source_text: s.text.clone(),
                translated_text: t.text.clone(),
                status: RepairStatus::AutoMatched,
                confidence: 1.0,
                notes: None,
            })
            .collect();

        return MechanicalRepairResult {
            repaired,
            problem_sections: Vec::new(),
        };
    }

    // Counts differ — try structure recovery
    let translation_texts: Vec<&str> = translation.iter().map(|t| t.text.as_str()).collect();

    if translation_texts.len() == source_count {
        let repaired: Vec<RepairedCue> = source
            .iter()
            .zip(translation_texts.iter())
            .map(|(s, t)| RepairedCue {
                id: s.id,
                start: s.start.clone(),
                end: s.end.clone(),
                source_text: s.text.clone(),
                translated_text: t.to_string(),
                status: RepairStatus::StructureRecovered,
                confidence: 0.9,
                notes: None,
            })
            .collect();

        return MechanicalRepairResult {
            repaired,
            problem_sections: Vec::new(),
        };
    }

    // Counts still don't match — localized problem detection
    let min_count = source_count.min(translation_texts.len());
    let mut repaired: Vec<RepairedCue> = Vec::new();

    // 1. Positionally map the overlapping portion
    for i in 0..min_count {
        repaired.push(RepairedCue {
            id: source[i].id,
            start: source[i].start.clone(),
            end: source[i].end.clone(),
            source_text: source[i].text.clone(),
            translated_text: translation_texts[i].to_string(),
            status: RepairStatus::AutoMatched,
            confidence: 0.7,
            notes: Some("Count mismatch — may need review".to_string()),
        });
    }

    // 2. Remaining source cues need review (translation has fewer texts)
    for s in source.iter().skip(min_count) {
        repaired.push(RepairedCue {
            id: s.id,
            start: s.start.clone(),
            end: s.end.clone(),
            source_text: s.text.clone(),
            translated_text: String::new(),
            status: RepairStatus::NeedsReview,
            confidence: 0.0,
            notes: Some("No matching translation text found".to_string()),
        });
    }

    // 3. Build localized problem section, NOT the entire range
    // The problem is only in the mismatched tail, with context cues before it
    let problem_start = if min_count > LLM_CONTEXT_CUES {
        min_count - LLM_CONTEXT_CUES
    } else {
        0
    };

    let repair_target_indices: Vec<usize> = (min_count..source_count).collect();

    let problem_sections = if source_count != translation_texts.len() {
        vec![ProblemSection {
            source_start_idx: problem_start,
            source_end_idx: source_count,
            translation_start_idx: problem_start.min(translation_texts.len()),
            translation_end_idx: translation_texts.len(),
            repair_target_indices,
        }]
    } else {
        Vec::new()
    };

    MechanicalRepairResult {
        repaired,
        problem_sections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_source_cues(texts: &[&str]) -> Vec<SourceCue> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| SourceCue {
                id: (i + 1) as u32,
                index: i,
                start: format!("00:00:{:02},000", i),
                end: format!("00:00:{:02},500", i + 1),
                text: t.to_string(),
            })
            .collect()
    }

    fn make_translation_cues(texts: &[&str]) -> Vec<TranslationCue> {
        texts
            .iter()
            .enumerate()
            .map(|(i, t)| TranslationCue {
                raw_index: i,
                possible_id: Some((i + 1) as u32),
                possible_start: None,
                possible_end: None,
                text: t.to_string(),
                confidence: 0.8,
            })
            .collect()
    }

    #[test]
    fn equal_counts_auto_matched() {
        let source = make_source_cues(&["Hello.", "World."]);
        let translation = make_translation_cues(&["こんにちは。", "世界。"]);
        let result = mechanical_repair(&source, &translation);

        assert_eq!(result.repaired.len(), 2);
        assert!(result.repaired.iter().all(|c| c.status == RepairStatus::AutoMatched));
        assert!(result.problem_sections.is_empty());
    }

    #[test]
    fn structure_recovery_when_text_count_matches() {
        let source = make_source_cues(&["Hello.", "World.", "Goodbye."]);
        let translation = make_translation_cues(&["こんにちは。", "世界。", "さようなら。"]);
        let result = mechanical_repair(&source, &translation);

        assert_eq!(result.repaired.len(), 3);
        assert!(result.repaired.iter().all(|c| c.status == RepairStatus::AutoMatched));
        assert!(result.problem_sections.is_empty());
    }

    #[test]
    fn mismatched_counts_localized_problem_section() {
        let source = make_source_cues(&[
            "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
            "K", "L", "M", "N", "O", // 15 total
        ]);
        // Only 12 translation texts (3 fewer = merged)
        let translation = make_translation_cues(&[
            "a", "b", "c", "d", "e", "f", "g", "h", "i", "j",
            "k", "l",
        ]);
        let result = mechanical_repair(&source, &translation);

        assert_eq!(result.repaired.len(), 15);
        // Last 3 cues should be NeedsReview
        assert_eq!(result.repaired[12].status, RepairStatus::NeedsReview);
        assert_eq!(result.repaired[13].status, RepairStatus::NeedsReview);
        assert_eq!(result.repaired[14].status, RepairStatus::NeedsReview);

        // Problem section should NOT start at 0 (not the whole file)
        assert!(!result.problem_sections.is_empty());
        let section = &result.problem_sections[0];
        // Should start at min_count - CONTEXT = 12 - 10 = 2
        assert_eq!(section.source_start_idx, 2);
        // Should end at source_count = 15
        assert_eq!(section.source_end_idx, 15);
        // Repair targets should be only the mismatched cues [12, 13, 14]
        assert_eq!(section.repair_target_indices, vec![12, 13, 14]);
    }

    #[test]
    fn preserves_source_structure() {
        let source = make_source_cues(&["Hello."]);
        let translation = make_translation_cues(&["こんにちは。"]);
        let result = mechanical_repair(&source, &translation);

        assert_eq!(result.repaired[0].id, 1);
        assert_eq!(result.repaired[0].start, "00:00:00,000");
        assert_eq!(result.repaired[0].end, "00:00:01,500");
        assert_eq!(result.repaired[0].source_text, "Hello.");
    }

    #[test]
    fn small_mismatch_full_context() {
        // When mismatch is small enough, context starts from 0
        let source = make_source_cues(&["A", "B", "C", "D", "E"]);
        let translation = make_translation_cues(&["a", "b"]); // 3 fewer
        let result = mechanical_repair(&source, &translation);

        let section = &result.problem_sections[0];
        // min_count=2, 2 < 10, so start at 0
        assert_eq!(section.source_start_idx, 0);
        assert_eq!(section.source_end_idx, 5);
        assert_eq!(section.repair_target_indices, vec![2, 3, 4]);
    }
}
