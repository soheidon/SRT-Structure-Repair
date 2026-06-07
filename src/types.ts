export interface LlmConfig {
  provider: string;      // "openai", "deepseek", "minimax", "kimi", "custom", or ""
  base_url: string;
  model: string;
  api_key_env: string;   // env var name, e.g. "OPENAI_API_KEY"
  configured: boolean;
}

export interface LlmProviderInfo {
  id: string;
  name: string;
  default_base_url: string;
  default_model: string;    // API model ID (e.g. "gpt-5.5", "kimi-k2.6")
  display_model: string;    // UI display name (e.g. "Kimi K2.6 Thinking")
  api_key_env: string;
  api_key_env_fallback?: string;
  detected: boolean;
}

export type RepairStatus =
  | "AutoMatched"
  | "StructureRecovered"
  | "LLMRepaired"
  | "NeedsReview"
  | "Unmatched";

export interface RepairedCue {
  id: number;
  start: string;
  end: string;
  source_text: string;
  translated_text: string;
  status: RepairStatus;
  confidence: number;
  notes?: string;
}

export interface RepairLogEntry {
  cue_id: number;
  start: string;
  end: string;
  status: RepairStatus;
  issue: string;
  source_text: string;
  translated_before: string;
  translated_after: string;
  confidence?: number;
}

export interface RepairSummary {
  total_cues: number;
  auto_matched: number;
  structure_recovered: number;
  llm_repaired: number;
  needs_review: number;
  unmatched: number;
  output_path: string;
  log_path: string;
  /** Whether the initial LLM repair phase failed entirely */
  llm_failed: boolean;
  /** Cues still needing attention (NeedsReview + Unmatched) */
  needs_review_cues: RepairedCue[];
  /** Cues where LLM API calls failed */
  llm_failed_cues: RepairedCue[];
  /** All repaired cues (for save_repaired_srt to work with) */
  repaired_cues: RepairedCue[];
  log_entries: RepairLogEntry[];
  process_log: string[];
}

/** A cue sent to the LLM for pure translation (not structure alignment). */
export interface BatchRepairCue {
  id: number;
  source_text: string;
  current_translation: string;
  context_before: string;
  context_after: string;
}

/** User's accept/reject decision on a batch translation candidate. */
export type BatchCueStatus = "Pending" | "Accepted" | "Rejected";

/** Result from batch LLM translation of a single cue. */
export interface BatchRepairResult {
  id: number;
  source_text: string;
  original_translation: string;
  llm_translation: string;
  confidence: number;
  status: BatchCueStatus;
  error?: string;
}

// ── Review Panel types ────────────────────────────────────────────────────

/** Client-side status for each cue in the unified review panel. */
export type ReviewCueStatus =
  | "unreviewed"       // Unmatched, not yet looked at
  | "needs_review"     // NeedsReview with non-empty translation
  | "candidate"        // Has AI candidate, not yet decided
  | "ai_individual_repaired"  // Individual AI retry succeeded
  | "ai_batch_repaired"       // Batch AI repair populated a candidate
  | "candidate_edited" // User edited the AI candidate manually
  | "accepted"         // User accepted this cue's translation
  | "rejected"         // User explicitly rejected
  | "empty"            // Source text is empty — cannot be repaired
  | "error";           // LLM API call failed for this cue

/** Unified cue representation for the review panel table + detail pane. */
export interface ReviewCue {
  id: number;
  start: string;                // from original SRT
  end: string;                  // from original SRT
  duration: string;             // computed: end - start
  sourceText: string;           // original English
  currentTranslation: string;   // current Japanese (may be empty)
  aiTranslation: string;        // LLM-generated translation
  editedTranslation: string;    // user manually edited translation
  confidence: number;           // LLM confidence (0-1), reference only
  status: ReviewCueStatus;
  selected: boolean;
  userEdited: boolean;
  note: string;                 // backend notes (e.g. "No matching translation text found")
  error: string;                // LLM error message
  isAiRepairable: boolean;      // has source text AND (no translation OR LLM failed)
}
