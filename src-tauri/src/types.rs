use serde::{Deserialize, Serialize};

/// A cue parsed strictly from a well-formed original English SRT file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceCue {
    /// Cue number from the SRT file (e.g., 1, 2, 3...)
    pub id: u32,
    /// Zero-based index in the parsed cue list
    pub index: usize,
    /// Start timestamp as "HH:MM:SS,mmm"
    pub start: String,
    /// End timestamp as "HH:MM:SS,mmm"
    pub end: String,
    /// English subtitle text (may contain newlines for multi-line subtitles)
    pub text: String,
}

/// A cue parsed loosely from a potentially damaged translated SRT file.
/// Structural fields (id, timestamps) are treated as unreliable hints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranslationCue {
    /// Position in the raw file
    pub raw_index: usize,
    /// Possible cue number if detected
    pub possible_id: Option<u32>,
    /// Possible start timestamp if detected
    pub possible_start: Option<String>,
    /// Possible end timestamp if detected
    pub possible_end: Option<String>,
    /// Extracted translated text
    pub text: String,
    /// Confidence in the extracted text (0.0 - 1.0)
    pub confidence: f64,
}

/// The repair status of a single cue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RepairStatus {
    /// Perfect positional match between source and translation
    AutoMatched,
    /// Translation text recovered but structural elements were damaged
    StructureRecovered,
    /// LLM successfully repaired this cue
    LLMRepaired,
    /// Needs manual review by the user
    NeedsReview,
    /// No translation found for this cue
    Unmatched,
}

/// A fully repaired cue ready for output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairedCue {
    pub id: u32,
    pub start: String,
    pub end: String,
    pub source_text: String,
    pub translated_text: String,
    pub status: RepairStatus,
    pub confidence: f64,
    pub notes: Option<String>,
}

/// Summary returned to the frontend after repair completes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairSummary {
    pub total_cues: usize,
    pub auto_matched: usize,
    pub structure_recovered: usize,
    pub llm_repaired: usize,
    pub needs_review: usize,
    pub unmatched: usize,
    pub output_path: String,
    /// Path to the generated .log file (companion to the SRT output)
    pub log_path: String,
    /// Whether the initial LLM repair phase failed entirely
    pub llm_failed: bool,
    /// Cues still needing attention (NeedsReview + Unmatched)
    pub needs_review_cues: Vec<RepairedCue>,
    /// Cues where LLM API calls failed
    pub llm_failed_cues: Vec<RepairedCue>,
    /// All repaired cues (for save_repaired_srt to work with)
    pub repaired_cues: Vec<RepairedCue>,
    /// Detailed log of non-AutoMatched cues for GUI display and .log file
    pub log_entries: Vec<RepairLogEntry>,
    /// Sequential process log of file load, parse, repair, and save events
    pub process_log: Vec<String>,
}

/// A cue sent to the LLM for pure translation (not structure alignment).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRepairCue {
    pub id: u32,
    /// Original English text (may be empty for blank cues — skipped by frontend)
    pub source_text: String,
    /// Current translation (may be empty if LLM failed)
    pub current_translation: String,
    /// Previous cue's source text for context
    pub context_before: String,
    /// Next cue's source text for context
    pub context_after: String,
}

/// Result from batch LLM translation of a single cue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchRepairResult {
    pub id: u32,
    pub source_text: String,
    pub original_translation: String,
    pub llm_translation: String,
    pub confidence: f64,
    pub status: BatchCueStatus,
    pub error: Option<String>,
}

/// User's accept/reject decision on a batch translation candidate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum BatchCueStatus {
    Pending,
    Accepted,
    Rejected,
}

/// A single entry in the repair log — one per non-AutoMatched cue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairLogEntry {
    pub cue_id: u32,
    pub start: String,
    pub end: String,
    pub status: RepairStatus,
    /// Human-readable Japanese description of what was fixed
    pub issue: String,
    /// Original English subtitle text
    pub source_text: String,
    /// Translation text before repair (mechanical result, possibly empty)
    pub translated_before: String,
    /// Translation text after repair (final result)
    pub translated_after: String,
    /// Confidence score from repair (None for Unmatched)
    pub confidence: Option<f64>,
}

/// LLM configuration persisted to user environment variables.
/// Stored fields reference the provider and env var name — never the raw key
/// (except for Custom, where SRT_REPAIR_LLM_API_KEY holds the actual value).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    /// Provider id: "openai", "deepseek", "minimax", "kimi", or "custom"
    pub provider: String,
    /// API base URL (resolved: defaults filled in for known providers)
    pub base_url: String,
    /// Model name (resolved: defaults filled in for known providers)
    pub model: String,
    /// Name of the environment variable that holds the API key
    /// (e.g., "OPENAI_API_KEY", "SRT_REPAIR_LLM_API_KEY")
    pub api_key_env: String,
    /// Whether the referenced env var actually contains a value
    pub configured: bool,
}

/// Describes a known LLM provider for the frontend provider selector.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderInfo {
    /// Machine-readable key: "openai", "deepseek", "minimax", "kimi", "custom"
    pub id: String,
    /// Human-readable display name: "OpenAI", "DeepSeek", "MiniMax", "Kimi", "Custom"
    pub name: String,
    /// Default base URL for this provider
    pub default_base_url: String,
    /// Default model ID for API calls (e.g. "gpt-5.5", "kimi-k2.6")
    pub default_model: String,
    /// Human-readable model name shown in UI (e.g. "Kimi K2.6 Thinking")
    pub display_model: String,
    /// Environment variable name that holds the API key
    pub api_key_env: String,
    /// Fallback env var name (only Kimi uses MOONSHOT_API_KEY with KIMI_API_KEY fallback)
    pub api_key_env_fallback: Option<String>,
    /// Whether an API key was detected in the environment
    pub detected: bool,
}

/// Internal representation of a known provider (without the runtime `detected` field).
pub(crate) struct KnownProvider {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) default_base_url: &'static str,
    pub(crate) default_model: &'static str,
    /// Human-readable model name shown in the UI (e.g. "Kimi K2.6 Thinking")
    pub(crate) display_model: &'static str,
    pub(crate) api_key_env: &'static str,
    pub(crate) api_key_env_fallback: Option<&'static str>,
    /// Optional extra JSON fields to merge into the chat completion request body.
    /// E.g., Kimi: `{"thinking": {"type": "enabled"}}`
    pub(crate) extra_body: Option<&'static str>,
}

pub(crate) const KNOWN_PROVIDERS: &[KnownProvider] = &[
    KnownProvider {
        id: "openai",
        name: "OpenAI",
        default_base_url: "https://api.openai.com/v1",
        default_model: "gpt-5.5",
        display_model: "GPT-5.5",
        api_key_env: "OPENAI_API_KEY",
        api_key_env_fallback: None,
        extra_body: None,
    },
    KnownProvider {
        id: "deepseek",
        name: "DeepSeek",
        default_base_url: "https://api.deepseek.com",
        default_model: "deepseek-v4-pro",
        display_model: "DeepSeek V4 Pro",
        api_key_env: "DEEPSEEK_API_KEY",
        api_key_env_fallback: None,
        extra_body: None,
    },
    KnownProvider {
        id: "minimax",
        name: "MiniMax",
        default_base_url: "https://api.minimax.io/v1",
        default_model: "MiniMax-M3",
        display_model: "MiniMax M3",
        api_key_env: "MINIMAX_API_KEY",
        api_key_env_fallback: None,
        extra_body: None,
    },
    KnownProvider {
        id: "kimi",
        name: "Kimi",
        default_base_url: "https://api.moonshot.ai/v1",
        default_model: "kimi-k2.6",
        display_model: "Kimi K2.6 Thinking",
        api_key_env: "MOONSHOT_API_KEY",
        api_key_env_fallback: Some("KIMI_API_KEY"),
        extra_body: Some(r#"{"thinking": {"type": "enabled"}}"#),
    },
];

/// Errors that can occur during SRT parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ParseError {
    EmptyFile,
    InvalidCueNumber { line: usize, found: String },
    InvalidTimestamp { line: usize, found: String },
    NonSequentialTimestamps { cue_id: u32 },
    NoTextExtracted,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::EmptyFile => write!(f, "File is empty"),
            ParseError::InvalidCueNumber { line, found } => {
                write!(f, "Invalid cue number at line {}: '{}'", line, found)
            }
            ParseError::InvalidTimestamp { line, found } => {
                write!(f, "Invalid timestamp at line {}: '{}'", line, found)
            }
            ParseError::NonSequentialTimestamps { cue_id } => {
                write!(f, "Non-sequential timestamp at cue {}", cue_id)
            }
            ParseError::NoTextExtracted => {
                write!(f, "No subtitle text could be extracted from the file")
            }
        }
    }
}
