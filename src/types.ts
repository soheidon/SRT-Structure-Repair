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
