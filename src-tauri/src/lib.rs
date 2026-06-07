mod config;
mod env_config;
mod llm_repair;
mod loose_parser;
mod output;
mod parser;
mod repair;
mod types;

use config::ConfigManager;
use types::ReviewLogEntry;
use repair::mechanical_repair;
use std::sync::Mutex;
use tauri::State;
use types::{BatchCueStatus, BatchRepairCue, BatchRepairResult, BatchTranslateMode, LlmConfig, LlmProviderInfo, RepairLogEntry, RepairStatus, RepairSummary, RepairedCue, KNOWN_PROVIDERS};

/// Resolve the actual API key from the given env var name.
/// Checks the primary env var first, then the fallback if the primary is empty.
fn read_api_key(api_key_env: &str, fallback: Option<&str>) -> String {
    let primary = env_config::read_config(api_key_env).unwrap_or_default();
    if !primary.is_empty() {
        return primary;
    }
    fallback
        .and_then(|fb| env_config::read_config(fb))
        .unwrap_or_default()
}

/// Look up a known provider by id.
fn find_known_provider(id: &str) -> Option<&'static types::KnownProvider> {
    types::KNOWN_PROVIDERS.iter().find(|p| p.id == id)
}

/// Generate a human-readable Japanese issue description for a repair log entry.
fn issue_for_status(status: &RepairStatus, notes: &Option<String>) -> String {
    match status {
        RepairStatus::StructureRecovered =>
            "翻訳SRTの構造（番号・タイムコード・空行）が壊れていたため、元SRTの構造で復元しました。".to_string(),
        RepairStatus::LLMRepaired =>
            "翻訳文が前後の字幕と結合・分割されていたため、AIで修復しました。".to_string(),
        RepairStatus::NeedsReview => {
            let extra = notes.as_deref().map(|n| format!(" ({})", n)).unwrap_or_default();
            format!("自動修復できませんでした。手動確認が必要です。{}", extra)
        }
        RepairStatus::Unmatched =>
            "対応する翻訳が見つかりませんでした。".to_string(),
        RepairStatus::AutoMatched => String::new(),
    }
}

/// Tracks temporary files and cleans them up on drop.
/// All temp files are deleted regardless of success or failure.
struct TempGuard {
    files: Vec<std::path::PathBuf>,
}

impl TempGuard {
    fn new() -> Self {
        TempGuard { files: Vec::new() }
    }

    /// Register a temp file for cleanup. Does nothing if the path doesn't exist.
    #[allow(dead_code)]
    fn track(&mut self, path: std::path::PathBuf) {
        self.files.push(path);
    }
}

impl Drop for TempGuard {
    fn drop(&mut self) {
        for path in &self.files {
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Single Tauri command that does everything:
/// 1. Accepts SRT content strings (read on the frontend via HTML5 D&D or file dialog)
/// 2. Parse original (strict) and translated (loose)
/// 3. Mechanical repair with localized problem detection
/// 4. Optional LLM repair for problem sections only (never full file)
/// 5. Auto-save output with -Repaired suffix to the user's home directory
/// 6. Return summary to frontend
///
/// No project files, persistent JSON, sidecar files, or subtitle logs
/// are created on disk beyond the output SRT and .log files.
#[tauri::command]
async fn repair_and_save_srt(
    original_srt: String,
    translated_srt: String,
    original_file_name: String,
    translated_file_name: String,
    state: State<'_, Mutex<ConfigManager>>,
) -> Result<RepairSummary, String> {
    // TempGuard cleans up any temp files when it goes out of scope,
    // regardless of whether we return Ok or Err.
    let _temp = TempGuard::new();

    // Extract work_dir from config before any .await
    let work_dir = {
        let mgr = state.lock().unwrap();
        output::resolve_work_dir(mgr.work_dir())
    };

    // Process log: sequential events shown in the "全ログ" tab and .log file
    let mut process_log: Vec<String> = Vec::new();

    // 1. Content is already provided (read by frontend via File.text())
    let original_content = original_srt;
    let translated_content = translated_srt;
    process_log.push(format!("元SRT読み込み完了: {} ({} bytes)", original_file_name, original_content.len()));
    process_log.push(format!("翻訳SRT読み込み完了: {} ({} bytes)", translated_file_name, translated_content.len()));

    process_log.push(format!("作業フォルダ: {}", work_dir.display()));

    // 2. Parse
    let source_cues = parser::parse_strict(&original_content)
        .map_err(|e| format!("Original SRT parse error: {}", e))?;

    let translation_cues = loose_parser::parse_loose(&translated_content)
        .map_err(|e| format!("Translated SRT parse error: {}", e))?;

    process_log.push(format!("元SRT cue数: {}", source_cues.len()));
    process_log.push(format!("翻訳SRT cue候補数: {}", translation_cues.len()));

    // 3. Mechanical repair with localized problem detection
    let mech_result = mechanical_repair(&source_cues, &translation_cues);
    let repaired = mech_result.repaired;

    if !mech_result.problem_sections.is_empty() {
        process_log.push(format!(
            "問題の字幕区間を検出: {}箇所",
            mech_result.problem_sections.len()
        ));
        for (i, section) in mech_result.problem_sections.iter().enumerate() {
            if let (Some(start_cue), Some(end_cue)) = (
                source_cues.get(section.source_start_idx),
                source_cues.get(
                    section.source_end_idx.saturating_sub(1),
                ),
            ) {
                process_log.push(format!(
                    "  区間{}: cue {}–{} ({}-{}) を問題箇所として検出",
                    i + 1,
                    start_cue.id,
                    end_cue.id,
                    start_cue.start,
                    end_cue.end
                ));
            }
        }
    } else {
        process_log.push("問題箇所は検出されませんでした。".to_string());
    }

    // 4. Count AI-eligible and empty-source cues (no LLM calls here)
    let ai_eligible_count = repaired
        .iter()
        .filter(|c| !c.source_text.is_empty() && c.translated_text.is_empty())
        .count();
    let empty_source_count = repaired
        .iter()
        .filter(|c| c.source_text.is_empty())
        .count();

    if ai_eligible_count > 0 || empty_source_count > 0 {
        process_log.push(format!("AI補完対象: {}件", ai_eligible_count));
        process_log.push(format!("空字幕: {}件", empty_source_count));
    }

    // Note: LLM repair is NOT run here.
    // AI translation completion is handled by the frontend via
    // `batch_translate_cues` (BatchRepairPanel) or per-cue retry (NeedsReviewList).

    // Collect NeedsReview and Unmatched cues for frontend display
    let needs_review_cues: Vec<RepairedCue> = repaired
        .iter()
        .filter(|c| c.status == RepairStatus::NeedsReview || c.status == RepairStatus::Unmatched)
        .cloned()
        .collect();

    // Clone all repaired cues for save_repaired_srt to work with later
    let repaired_cues = repaired.clone();

    // 5. Generate and auto-save output
    let output_path = output::determine_output_path(&translated_file_name, &work_dir);
    let srt_content = output::generate_srt(&repaired);

    std::fs::write(&output_path, &srt_content)
        .map_err(|e| format!("Failed to write output SRT: {}", e))?;
    process_log.push(format!("出力SRT保存: {}", output_path));

    // 6. Compute stats
    let total_cues = repaired.len();
    let auto_matched = repaired
        .iter()
        .filter(|c| c.status == RepairStatus::AutoMatched)
        .count();
    let structure_recovered = repaired
        .iter()
        .filter(|c| c.status == RepairStatus::StructureRecovered)
        .count();
    let needs_review = needs_review_cues.len();
    let unmatched = repaired
        .iter()
        .filter(|c| c.status == RepairStatus::Unmatched)
        .count();

    // 7. Build repair log entries (non-AutoMatched cues only)
    let mut log_entries: Vec<RepairLogEntry> = Vec::new();
    for cue in repaired.iter() {
        if cue.status == RepairStatus::AutoMatched {
            continue;
        }
        log_entries.push(RepairLogEntry {
            cue_id: cue.id,
            start: cue.start.clone(),
            end: cue.end.clone(),
            status: cue.status.clone(),
            issue: issue_for_status(&cue.status, &cue.notes),
            source_text: cue.source_text.clone(),
            translated_before: String::new(),
            translated_after: cue.translated_text.clone(),
            confidence: if cue.confidence > 0.0 { Some(cue.confidence) } else { None },
        });
    }

    // 8. Save repair log file
    let log_path = output::determine_log_path(&translated_file_name, &work_dir);
    let log_content = output::generate_log(
        &log_entries,
        &process_log,
        &original_file_name,
        &translated_file_name,
        &output_path,
        total_cues,
        auto_matched,
        structure_recovered,
        0, // llm_repaired — always 0 (AI repair is separate)
        needs_review,
        unmatched,
    );
    std::fs::write(&log_path, &log_content)
        .map_err(|e| format!("Failed to write repair log: {}", e))?;
    process_log.push(format!("出力LOG保存: {}", log_path));

    // TempGuard::drop runs here, cleaning up any temp files

    Ok(RepairSummary {
        total_cues,
        auto_matched,
        structure_recovered,
        llm_repaired: 0,
        needs_review,
        unmatched,
        output_path,
        log_path,
        llm_failed: false,
        needs_review_cues,
        llm_failed_cues: vec![],
        repaired_cues,
        log_entries,
        process_log,
    })
}

/// Private helper: read stored LLM config from env vars.
/// Used by both the tauri command and repair_and_save_srt internally.
/// Read LLM configuration from stored config.
#[tauri::command]
fn get_llm_config(state: State<'_, Mutex<ConfigManager>>) -> LlmConfig {
    state.lock().unwrap().to_llm_config()
}

/// Scan all known providers and check if their env vars are set.
#[tauri::command]
fn scan_llm_providers() -> Vec<LlmProviderInfo> {
    let mut providers: Vec<LlmProviderInfo> = KNOWN_PROVIDERS
        .iter()
        .map(|kp| {
            let detected = !read_api_key(kp.api_key_env, kp.api_key_env_fallback).is_empty();
            LlmProviderInfo {
                id: kp.id.to_string(),
                name: kp.name.to_string(),
                default_base_url: kp.default_base_url.to_string(),
                default_model: kp.default_model.to_string(),
                display_model: kp.display_model.to_string(),
                api_key_env: kp.api_key_env.to_string(),
                api_key_env_fallback: kp.api_key_env_fallback.map(|s| s.to_string()),
                detected,
            }
        })
        .collect();

    // Add Custom provider
    let custom_detected = env_config::read_config("SRT_REPAIR_LLM_API_KEY")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    providers.push(LlmProviderInfo {
        id: "custom".to_string(),
        name: "Custom".to_string(),
        default_base_url: String::new(),
        default_model: String::new(),
        display_model: String::new(),
        api_key_env: "SRT_REPAIR_LLM_API_KEY".to_string(),
        api_key_env_fallback: None,
        detected: custom_detected,
    });

    providers
}

/// Save LLM configuration to config file.
/// For known providers, `api_key_value` should be None (the key lives in the provider's standard env var).
/// For Custom, `api_key_value` is written to SRT_REPAIR_LLM_API_KEY.
#[tauri::command]
fn save_llm_config(
    provider: String,
    base_url: String,
    model: String,
    api_key_env: String,
    api_key_value: Option<String>,
    state: State<'_, Mutex<ConfigManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    mgr.set_ai_config(&provider, &base_url, &model, &api_key_env)?;

    if provider == "custom" {
        // For Custom, store the key value directly in SRT_REPAIR_LLM_API_KEY
        let key = api_key_value.unwrap_or_default();
        if key.is_empty() {
            let _ = env_config::delete_config("SRT_REPAIR_LLM_API_KEY");
        } else {
            env_config::write_config("SRT_REPAIR_LLM_API_KEY", &key)?;
        }
    }
    Ok(())
}

/// Delete all LLM configuration from the config file.
#[tauri::command]
fn delete_llm_config(state: State<'_, Mutex<ConfigManager>>) -> Result<(), String> {
    let mut mgr = state.lock().unwrap();
    mgr.clear_ai_config()?;
    // Also delete the custom API key env var if it exists
    let _ = env_config::delete_config("SRT_REPAIR_LLM_API_KEY");
    Ok(())
}

/// Test the LLM connection with a minimal API call that validates JSON format.
/// Resolves the API key from the specified env var at test time.
/// On success, records the provider/model as verified in the config.
#[tauri::command]
async fn test_llm_connection(
    provider: String,
    base_url: String,
    model: String,
    api_key_env: String,
    api_key_fallback: Option<String>,
    state: State<'_, Mutex<ConfigManager>>,
) -> Result<String, String> {
    let api_key = read_api_key(&api_key_env, api_key_fallback.as_deref());
    if api_key.is_empty() {
        return Err(format!(
            "APIキーが設定されていません。環境変数 {} を設定してください。",
            api_key_env
        ));
    }

    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    // Use a JSON response test — validates both HTTP connectivity AND JSON format compliance
    let body = serde_json::json!({
        "model": model,
        "messages": [
            {"role": "system", "content": "Return ONLY valid JSON. No other text."},
            {"role": "user", "content": "Return exactly: {\"translations\":[{\"id\":1,\"translation\":\"OK\",\"confidence\":1.0}]}"}
        ],
        "max_tokens": 100,
        "temperature": 0.0,
        "response_format": {"type": "json_object"}
    });

    let client = reqwest::Client::new();
    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("接続エラー: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("APIエラー {}: {}", status, body_text));
    }

    let response_body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response JSON: {}", e))?;

    let content = response_body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "Response missing content field".to_string())?;

    // Validate JSON format: must contain a "translations" array with at least one item
    let parsed: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| format!("JSONパース失敗: {} — raw content: {}", e, content))?;

    let arr = parsed
        .get("translations")
        .or_else(|| parsed.get("cues"))
        .or_else(|| parsed.get("reviews"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            format!(
                "JSON形式が不正です（translations/cues/reviews 配列が見つかりません）: {}",
                content
            )
        })?;

    if arr.is_empty() {
        return Err(format!("翻訳結果が空です: {}", content));
    }

    let first = &arr[0];
    let has_id = first.get("id").and_then(|v| v.as_u64()).is_some();
    let has_translation = first.get("translation").and_then(|v| v.as_str()).is_some();
    let has_suggested = first.get("suggested_translation").and_then(|v| v.as_str()).is_some();
    let has_review_status = first.get("review_status").and_then(|v| v.as_str()).is_some();

    if has_id && (has_translation || has_suggested || has_review_status) {
        // Validate workspace directory is writable
        let wd = {
            let mgr = state.lock().unwrap();
            output::resolve_work_dir(mgr.work_dir())
        };
        if let Err(e) = std::fs::create_dir_all(wd.join("outputs")) {
            return Err(format!("作業フォルダに書き込めません: {}", e));
        }
        // Mark connection success in config
        {
            let mut mgr = state.lock().unwrap();
            let _ = mgr.mark_connection_success(&provider, &model);
        }
        Ok(format!(
            "接続テスト成功 — JSON形式OK（{}件の結果）",
            arr.len()
        ))
    } else {
        Err(format!(
            "JSON形式が不正です（id/translation フィールド不足）: {}",
            content
        ))
    }
}

/// Batch translate needs-review cues using LLM.
///
/// Splits the input cues into batches of `batch_size` and calls the LLM for
/// pure translation (no SRT structure). Returns results with Pending status.
#[tauri::command]
async fn batch_translate_cues(
    cues: Vec<BatchRepairCue>,
    batch_size: usize,
    mode: String,
    state: State<'_, Mutex<ConfigManager>>,
) -> Result<Vec<BatchRepairResult>, String> {
    if cues.is_empty() {
        return Ok(Vec::new());
    }

    let mode = match mode.as_str() {
        "retranslate" => BatchTranslateMode::Retranslate,
        "supplement_untranslated" => BatchTranslateMode::SupplementUntranslated,
        "review" => BatchTranslateMode::Review,
        _ => BatchTranslateMode::Retranslate, // safe default
    };

    // Extract LLM config before any .await
    let (_llm_config, api_key, endpoint, model, extra_body) = {
        let mgr = state.lock().unwrap();
        let llm_config = mgr.to_llm_config();
        if !llm_config.configured {
            return Err("AIが設定されていません。".to_string());
        }
        let api_key = read_api_key(&llm_config.api_key_env, None);
        let endpoint = format!(
            "{}/chat/completions",
            llm_config.base_url.trim_end_matches('/')
        );
        let model = llm_config.model.clone();
        let extra_body: Option<serde_json::Value> = find_known_provider(&llm_config.provider)
            .and_then(|kp| kp.extra_body)
            .and_then(|s| serde_json::from_str(s).ok());
        (llm_config, api_key, endpoint, model, extra_body)
    };

    let effective_batch_size = if batch_size == 0 { 15 } else { batch_size };

    let mut all_results: Vec<BatchRepairResult> = Vec::new();

    for (batch_idx, chunk) in cues.chunks(effective_batch_size).enumerate() {
        match llm_repair::translate_cues_batch(
            chunk,
            mode,
            &api_key,
            &endpoint,
            &model,
            extra_body.as_ref(),
        )
        .await
        {
            Ok(mut results) => {
                all_results.append(&mut results);
            }
            Err(e) => {
                // Mark all cues in this batch as errors
                for cue in chunk {
                    all_results.push(BatchRepairResult {
                        id: cue.id,
                        source_text: cue.source_text.clone(),
                        original_translation: cue.current_translation.clone(),
                        llm_translation: String::new(),
                        confidence: 0.0,
                        status: BatchCueStatus::Pending,
                        error: Some(format!(
                            "バッチ {} 失敗: {}",
                            batch_idx + 1,
                            e
                        )),
                        review_status: None,
                        review_comment: None,
                    });
                }
            }
        }
    }

    all_results.sort_by_key(|r| r.id);
    Ok(all_results)
}

/// Save accepted LLM translations into a new SRT file.
///
/// Takes the original repaired cues, merges accepted LLM translations, and
/// writes a new SRT file with `_Repaired_after_llm` suffix. Never overwrites.
#[tauri::command]
fn save_repaired_srt(
    repaired_cues: Vec<RepairedCue>,
    accepted_translations: Vec<BatchRepairResult>,
    translated_file_name: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    // Build a map of accepted translations: cue_id → new text
    let accepted_map: std::collections::HashMap<u32, String> = accepted_translations
        .iter()
        .filter(|r| r.status == BatchCueStatus::Accepted && !r.llm_translation.is_empty())
        .map(|r| (r.id, r.llm_translation.clone()))
        .collect();

    // Merge accepted translations into repaired cues
    let merged: Vec<RepairedCue> = repaired_cues
        .into_iter()
        .map(|mut cue| {
            if let Some(new_text) = accepted_map.get(&cue.id) {
                cue.translated_text = new_text.clone();
                cue.status = RepairStatus::LLMRepaired;
                cue.notes = Some("AI一括修正で翻訳補完".to_string());
            }
            cue
        })
        .collect();

    // Use provided output directory, or default to workspace
    let output_path = if let Some(ref dir) = output_dir {
        output::determine_output_path_llm_in_dir(&translated_file_name, dir)
    } else {
        let wd = output::default_work_dir();
        output::determine_output_path_llm(&translated_file_name, &wd)
    };
    let srt_content = output::generate_srt(&merged);

    std::fs::write(&output_path, &srt_content)
        .map_err(|e| format!("Failed to write LLM-repaired SRT: {}", e))?;

    Ok(output_path)
}

/// Predict the output path for LLM-repaired SRT without creating the file.
/// Used by the frontend to show users where the file will be saved.
#[tauri::command]
fn predict_llm_output_path(translated_file_name: String, output_dir: Option<String>) -> String {
    if let Some(dir) = output_dir {
        output::determine_output_path_llm_in_dir(&translated_file_name, &dir)
    } else {
        let wd = output::default_work_dir();
        output::determine_output_path_llm(&translated_file_name, &wd)
    }
}

/// Get the current workspace directory path (resolved, with default fallback).
#[tauri::command]
fn get_work_dir(state: State<'_, Mutex<ConfigManager>>) -> String {
    let mgr = state.lock().unwrap();
    output::resolve_work_dir(mgr.work_dir()).to_string_lossy().to_string()
}

/// Set the workspace directory and persist it.
/// Creates the directory (and subdirectories) if they don't exist.
#[tauri::command]
fn set_work_dir(dir: String, state: State<'_, Mutex<ConfigManager>>) -> Result<(), String> {
    let p = std::path::Path::new(&dir);
    if !p.is_absolute() {
        return Err("作業フォルダは絶対パスで指定してください。".to_string());
    }
    // Create the directory and essential subdirectories
    std::fs::create_dir_all(p.join("outputs"))
        .map_err(|e| format!("作業フォルダを作成できません: {}", e))?;
    std::fs::create_dir_all(p.join("logs"))
        .map_err(|e| format!("logsサブフォルダを作成できません: {}", e))?;
    std::fs::create_dir_all(p.join("work"))
        .map_err(|e| format!("workサブフォルダを作成できません: {}", e))?;
    state.lock().unwrap().set_work_dir(&dir)
}

/// Reset the workspace directory to the default (Documents\SRTRepair).
/// Returns the new default path.
#[tauri::command]
fn reset_work_dir(state: State<'_, Mutex<ConfigManager>>) -> Result<String, String> {
    state.lock().unwrap().reset_work_dir()?;
    Ok(output::default_work_dir().to_string_lossy().to_string())
}

/// Open the workspace directory in the OS file explorer.
#[tauri::command]
fn open_work_dir(state: State<'_, Mutex<ConfigManager>>) -> Result<(), String> {
    let mgr = state.lock().unwrap();
    let dir = output::resolve_work_dir(mgr.work_dir());
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open work dir: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open work dir: {}", e))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(dir.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to open work dir: {}", e))?;
    }
    Ok(())
}

/// Open a file with the OS default application.
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Open the folder containing a file, selecting the file if possible (Windows).
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Open Explorer with the file selected
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // Linux: open the parent directory
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    Ok(())
}

/// Copy a string to the system clipboard.
#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("Failed to access clipboard: {}", e))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;
    Ok(())
}

/// Save the review action log to a JSON file in the logs folder.
#[tauri::command]
fn save_review_log(
    log_entries: Vec<ReviewLogEntry>,
    translated_file_name: String,
    work_dir: Option<String>,
) -> Result<String, String> {
    let wd = work_dir
        .map(std::path::PathBuf::from)
        .unwrap_or_else(output::default_work_dir);
    let path = output::determine_review_log_path(&translated_file_name, &wd);
    let json = serde_json::to_string_pretty(&log_entries)
        .map_err(|e| format!("JSON serialization failed: {}", e))?;
    std::fs::write(&path, &json)
        .map_err(|e| format!("Failed to write review log: {}", e))?;
    Ok(path)
}

/// Persist the last-opened settings tab for next app launch.
#[tauri::command]
fn set_last_settings_tab(tab: String, state: State<'_, Mutex<ConfigManager>>) -> Result<(), String> {
    state.lock().unwrap().set_last_settings_tab(&tab)
}

/// Get the last-opened settings tab ("ai" or "workdir").
#[tauri::command]
fn get_last_settings_tab(state: State<'_, Mutex<ConfigManager>>) -> String {
    state.lock().unwrap().last_settings_tab().to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Mutex::new(ConfigManager::load().expect("Failed to load config")))
        .invoke_handler(tauri::generate_handler![
            repair_and_save_srt,
            get_llm_config,
            save_llm_config,
            delete_llm_config,
            test_llm_connection,
            scan_llm_providers,
            batch_translate_cues,
            save_repaired_srt,
            predict_llm_output_path,
            get_work_dir,
            set_work_dir,
            reset_work_dir,
            open_work_dir,
            open_file,
            open_folder,
            copy_to_clipboard,
            save_review_log,
            set_last_settings_tab,
            get_last_settings_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
