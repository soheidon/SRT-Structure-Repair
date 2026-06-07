use serde::{Deserialize, Serialize};

/// OpenAI-compatible chat completion request body.
#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    temperature: f64,
    response_format: Option<ResponseFormat>,
}

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    format_type: String,
}

/// Response from a pure translation batch call.
#[derive(Debug, Deserialize)]
struct TranslationBatchResponse {
    translations: Vec<TranslationItem>,
}

#[derive(Debug, Deserialize)]
struct TranslationItem {
    id: u32,
    translation: String,
    confidence: f64,
}

/// Response from a review batch call.
#[derive(Debug, Deserialize)]
struct ReviewBatchResponse {
    reviews: Vec<ReviewItem>,
}

#[derive(Debug, Deserialize)]
struct ReviewItem {
    id: u32,
    review_status: String,
    #[serde(default)]
    issue_type: Option<String>,
    #[serde(default)]
    comment: Option<String>,
    #[serde(default)]
    suggested_translation: Option<String>,
    #[serde(default)]
    confidence: f64,
}

/// Parse the LLM's JSON response for translation items.
///
/// Tries three strategies in order:
/// 1. Structured deserialization expecting root key `"translations"`
/// 2. Fallback: root key `"cues"` (some models use this)
/// 3. Partial salvage: extract individual `{id, translation, confidence}` objects
///    from any array found under any key in the response
fn parse_translation_response(content: &str) -> Result<Vec<TranslationItem>, String> {
    // Strategy 1: structured parse expecting "translations" key
    if let Ok(response) = serde_json::from_str::<TranslationBatchResponse>(content) {
        return Ok(response.translations);
    }

    // Strategy 2: fallback — try "cues" key
    if let Ok(root) = serde_json::from_str::<serde_json::Value>(content) {
        // Try "cues" array
        if let Some(cues_arr) = root.get("cues").and_then(|v| v.as_array()) {
            let items: Vec<TranslationItem> = cues_arr
                .iter()
                .filter_map(|v| {
                    Some(TranslationItem {
                        id: v.get("id")?.as_u64()? as u32,
                        translation: v.get("translation")?.as_str()?.to_string(),
                        confidence: v.get("confidence")?.as_f64()?,
                    })
                })
                .collect();
            if !items.is_empty() {
                return Ok(items);
            }
        }

        // Strategy 3: partial salvage — scan any array field for {id, translation, confidence} objects
        if let Some(obj) = root.as_object() {
            for (_key, val) in obj {
                if let Some(arr) = val.as_array() {
                    let items: Vec<TranslationItem> = arr
                        .iter()
                        .filter_map(|v| {
                            let id = v.get("id")?.as_u64()? as u32;
                            let translation = v.get("translation")?.as_str()?.to_string();
                            let confidence = v.get("confidence")?.as_f64().unwrap_or(0.5);
                            Some(TranslationItem { id, translation, confidence })
                        })
                        .collect();
                    if !items.is_empty() {
                        return Ok(items);
                    }
                }
            }
        }
    }

    Err(format!(
        "Failed to parse LLM translation JSON: no 'translations' or 'cues' array found.\nContent: {}",
        content
    ))
}

/// Parse the LLM's JSON response for review items.
///
/// Tries similar strategies as `parse_translation_response`:
/// 1. Structured deserialization expecting root key `"reviews"`
/// 2. Fallback: scan any array for `{id, review_status, ...}` objects
fn parse_review_response(content: &str) -> Result<Vec<ReviewItem>, String> {
    // Strategy 1: structured parse expecting "reviews" key
    if let Ok(response) = serde_json::from_str::<ReviewBatchResponse>(content) {
        return Ok(response.reviews);
    }

    // Strategy 2: fallback — scan any array field for review-like objects
    if let Ok(root) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(obj) = root.as_object() {
            for (_key, val) in obj {
                if let Some(arr) = val.as_array() {
                    let items: Vec<ReviewItem> = arr
                        .iter()
                        .filter_map(|v| {
                            let id = v.get("id")?.as_u64()? as u32;
                            let review_status = v
                                .get("review_status")
                                .and_then(|s| s.as_str())
                                .unwrap_or("unknown")
                                .to_string();
                            let issue_type = v
                                .get("issue_type")
                                .and_then(|s| s.as_str())
                                .map(|s| s.to_string());
                            let comment = v
                                .get("comment")
                                .and_then(|s| s.as_str())
                                .map(|s| s.to_string());
                            let suggested_translation = v
                                .get("suggested_translation")
                                .and_then(|s| s.as_str())
                                .map(|s| s.to_string());
                            let confidence = v.get("confidence").and_then(|n| n.as_f64()).unwrap_or(0.5);
                            Some(ReviewItem {
                                id,
                                review_status,
                                issue_type,
                                comment,
                                suggested_translation,
                                confidence,
                            })
                        })
                        .collect();
                    if !items.is_empty() {
                        return Ok(items);
                    }
                }
            }
        }
    }

    Err(format!(
        "Failed to parse LLM review JSON: no 'reviews' array found.\nContent: {}",
        content
    ))
}

/// Common translation rules applied to ALL modes.
const COMMON_RULES: &str = r#"あなたは日本語字幕翻訳者です。英語字幕を自然な日本語字幕にしてください。

ルール:
- SRT番号とタイムコードは変更しない
- 出力はJSONのみ
- 日本語字幕は短く自然にする
- 性別に基づく過剰な女言葉・男言葉は避ける
- 基本は中性的で簡潔な字幕調にする
- 身分差、親密度、敵対関係は必要に応じて反映する
- 字幕なので、訳文末の句点「。」は原則として付けない
- 読点「、」も必要以上に使わない
- 意味を補いすぎない
- 固有名詞は用語表があれば従う"#;

/// Translate/review a batch of cues using an LLM.
///
/// The mode determines the system prompt and expected response format:
/// - Retranslate: fresh translation from English source
/// - SupplementUntranslated: only fill in missing translations
/// - Review: assess quality, suggest improvements
pub async fn translate_cues_batch(
    cues: &[crate::types::BatchRepairCue],
    mode: crate::types::BatchTranslateMode,
    api_key: &str,
    endpoint: &str,
    model: &str,
    extra_body: Option<&serde_json::Value>,
) -> Result<Vec<crate::types::BatchRepairResult>, String> {
    if cues.is_empty() {
        return Ok(Vec::new());
    }

    // Build mode-aware system prompt
    let mode_instructions = match mode {
        crate::types::BatchTranslateMode::Retranslate => r#"

Translate the following English subtitles into natural, fluent Japanese.

Rules:
1. Translate each cue independently based on its source_text.
2. Use the context_before and context_after fields only for consistency — do NOT merge or combine cues.
3. Use the current_translation field as a reference for style/tone, but produce a fresh translation.
4. If source_text is empty, return an empty translation.
5. Keep translations concise — suitable for subtitle display.

Response format (ABSOLUTE — do not deviate):
{
  "translations": [
    {"id": <cue_id>, "translation": "<japanese text>", "confidence": <0.0-1.0>},
    ...
  ]
}"#,
        crate::types::BatchTranslateMode::SupplementUntranslated => r#"

Fill in ONLY the missing Japanese translations for English subtitle cues.

Rules:
1. If current_translation is NOT empty, keep it as-is and return it unchanged.
2. If current_translation IS empty, produce a new natural Japanese translation from source_text.
3. Use context_before and context_after only for consistency.
4. If source_text is also empty, return an empty translation.
5. Keep translations concise — suitable for subtitle display.

Response format (ABSOLUTE — do not deviate):
{
  "translations": [
    {"id": <cue_id>, "translation": "<japanese text or existing>", "confidence": <0.0-1.0>},
    ...
  ]
}"#,
        crate::types::BatchTranslateMode::Review => r#"

Review the following subtitle translations for quality, consistency, and naturalness.
For each cue, assess the translation and suggest improvements if needed.

Rules:
1. Evaluate if the Japanese translation matches the English source in meaning and tone.
2. If the translation is good, set review_status to "ok" and leave suggested_translation empty.
3. If the translation needs improvement, set review_status to "needs_review" and provide a suggested_translation.
4. If the source_text is empty but current_translation exists, flag as "source_empty_target_exists".
5. If source_text and current_translation are both empty, status is "empty".
6. Return ONLY valid JSON with the root key "reviews".

Response format (ABSOLUTE — do not deviate):
{
  "reviews": [
    {
      "id": <cue_id>,
      "review_status": "<ok|needs_review|source_empty_target_exists|empty|error>",
      "issue_type": "<brief issue category or null>",
      "comment": "<brief quality assessment>",
      "suggested_translation": "<improved japanese text or null>",
      "confidence": <0.0-1.0>
    },
    ...
  ]
}"#,
    };

    let system_prompt = format!("{}{}", COMMON_RULES, mode_instructions);

    // Build a compact JSON array of cues for the LLM
    let cue_items: Vec<serde_json::Value> = cues
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "source_text": c.source_text,
                "current_translation": c.current_translation,
                "context_before": c.context_before,
                "context_after": c.context_after,
            })
        })
        .collect();

    let user_message = serde_json::to_string_pretty(&serde_json::json!({
        "cues": cue_items
    }))
    .unwrap_or_else(|_| "{}".to_string());

    let mode_label = match mode {
        crate::types::BatchTranslateMode::Retranslate => "translate",
        crate::types::BatchTranslateMode::SupplementUntranslated => "supplement missing translations for",
        crate::types::BatchTranslateMode::Review => "review",
    };

    let response_key = match mode {
        crate::types::BatchTranslateMode::Retranslate
        | crate::types::BatchTranslateMode::SupplementUntranslated => "translations",
        crate::types::BatchTranslateMode::Review => "reviews",
    };

    let chat_request = ChatCompletionRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt,
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "Please {} the following {} subtitle cues.\n\nReturn a JSON object with root key \"{}\".\n\nInput cues:\n{}",
                    mode_label,
                    cues.len(),
                    response_key,
                    user_message
                ),
            },
        ],
        temperature: 0.2,
        response_format: Some(ResponseFormat {
            format_type: "json_object".to_string(),
        }),
    };

    let mut request_body = serde_json::to_value(&chat_request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;

    if let Some(extra) = extra_body {
        if let Some(obj) = request_body.as_object_mut() {
            if let Some(extra_obj) = extra.as_object() {
                for (key, val) in extra_obj {
                    obj.insert(key.clone(), val.clone());
                }
            }
        }
    }

    let client = reqwest::Client::new();
    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("LLM API request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("LLM API error {}: {}", status, body));
    }

    let response_body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

    let content = response_body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "LLM response missing content".to_string())?;

    // Build results, preserving original cue data
    let mut cue_map: std::collections::HashMap<u32, &crate::types::BatchRepairCue> =
        cues.iter().map(|c| (c.id, c)).collect();

    let results: Vec<crate::types::BatchRepairResult> = match mode {
        crate::types::BatchTranslateMode::Retranslate
        | crate::types::BatchTranslateMode::SupplementUntranslated => {
            let parsed_items: Vec<TranslationItem> = parse_translation_response(content)?;
            parsed_items
                .into_iter()
                .map(|item| {
                    let original = cue_map.remove(&item.id);
                    crate::types::BatchRepairResult {
                        id: item.id,
                        source_text: original.map(|c| c.source_text.clone()).unwrap_or_default(),
                        original_translation: original
                            .map(|c| c.current_translation.clone())
                            .unwrap_or_default(),
                        llm_translation: item.translation,
                        confidence: item.confidence,
                        status: crate::types::BatchCueStatus::Pending,
                        error: None,
                        review_status: None,
                        review_comment: None,
                    }
                })
                .collect()
        }
        crate::types::BatchTranslateMode::Review => {
            let parsed_items: Vec<ReviewItem> = parse_review_response(content)?;
            parsed_items
                .into_iter()
                .map(|item| {
                    let original = cue_map.remove(&item.id);
                    let comment = match (&item.issue_type, &item.comment) {
                        (Some(issue), Some(c)) => format!("[{}] {}", issue, c),
                        (Some(issue), None) => issue.clone(),
                        (None, Some(c)) => c.clone(),
                        (None, None) => String::new(),
                    };
                    crate::types::BatchRepairResult {
                        id: item.id,
                        source_text: original.map(|c| c.source_text.clone()).unwrap_or_default(),
                        original_translation: original
                            .map(|c| c.current_translation.clone())
                            .unwrap_or_default(),
                        llm_translation: item.suggested_translation.unwrap_or_default(),
                        confidence: item.confidence,
                        status: crate::types::BatchCueStatus::Pending,
                        error: None,
                        review_status: Some(item.review_status),
                        review_comment: if comment.is_empty() { None } else { Some(comment) },
                    }
                })
                .collect()
        }
    };

    // Add any cues the LLM didn't return as errors
    let mut all_results = results;
    for (id, cue) in cue_map {
        all_results.push(crate::types::BatchRepairResult {
            id,
            source_text: cue.source_text.clone(),
            original_translation: cue.current_translation.clone(),
            llm_translation: String::new(),
            confidence: 0.0,
            status: crate::types::BatchCueStatus::Pending,
            error: Some("LLM did not return a result for this cue".to_string()),
            review_status: None,
            review_comment: None,
        });
    }

    // Sort by ID for consistent ordering
    all_results.sort_by_key(|r| r.id);

    Ok(all_results)
}
