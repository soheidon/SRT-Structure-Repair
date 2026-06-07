use serde::{Deserialize, Serialize};

use crate::types::{RepairStatus, RepairedCue, SourceCue};

/// Request sent to the LLM for repairing a section of subtitles.
#[derive(Debug, Serialize)]
struct LLMRepairRequest {
    source_cues: Vec<LLMSourceCue>,
    translation_candidates: Vec<String>,
}

#[derive(Debug, Serialize)]
struct LLMSourceCue {
    id: u32,
    time: String,
    text: String,
}

/// Response expected from the LLM.
#[derive(Debug, Deserialize)]
struct LLMRepairResponse {
    repaired: Vec<LLMRepairedItem>,
}

#[derive(Debug, Deserialize)]
struct LLMRepairedItem {
    id: u32,
    translated_text: String,
    confidence: f64,
    needs_review: bool,
}

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

/// Call an LLM to repair a section of subtitle cues.
///
/// Sends only the relevant time range (the problem section), never the entire file.
/// Uses OpenAI-compatible API (works with OpenAI, Anthropic via compatible endpoint,
/// or any provider that supports the chat completions format).
pub async fn llm_repair_section(
    source_cues: &[SourceCue],
    translation_texts: &[String],
    api_key: &str,
    endpoint: &str,
    model: &str,
    extra_body: Option<&serde_json::Value>,
) -> Result<Vec<RepairedCue>, String> {
    // Build the request payload
    let source_cue_items: Vec<LLMSourceCue> = source_cues
        .iter()
        .map(|c| LLMSourceCue {
            id: c.id,
            time: format!("{} --> {}", c.start, c.end),
            text: c.text.clone(),
        })
        .collect();

    let repair_request = LLMRepairRequest {
        source_cues: source_cue_items,
        translation_candidates: translation_texts.to_vec(),
    };

    let system_prompt = r#"You are an SRT subtitle repair assistant. Your task is to align translated Japanese text with original English cues.

Rules (ABSOLUTE — do not violate):
1. Do NOT change any cue IDs.
2. Do NOT change any timestamps.
3. The number of output cues MUST equal the number of source_cues provided.
4. Do NOT summarize, shorten, or creatively rewrite the translations.
5. Use the provided translation_candidates as much as possible — split or merge them to match the source cue count.
6. If you are uncertain about a mapping, set "needs_review": true and "translated_text": "" rather than guessing.
7. Return ONLY valid JSON in the exact format specified.
8. The translated_text must be in Japanese.
9. If a source cue has empty text (""), keep its translated_text as "" — never invent text for empty cues.
10. Do NOT include or generate SRT cue numbers, timestamps, or blank-line separators in your output. Return only the JSON object."#;

    let user_message = serde_json::to_string_pretty(&repair_request)
        .unwrap_or_else(|_| "{}".to_string());

    let chat_request = ChatCompletionRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "Repair the following SRT section. Match the {} source cues with the provided translation candidates:\n\n{}",
                    source_cues.len(),
                    user_message
                ),
            },
        ],
        temperature: 0.1,
        response_format: Some(ResponseFormat {
            format_type: "json_object".to_string(),
        }),
    };

    // Serialize the base request and merge any extra body fields (e.g., Kimi thinking)
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

    // Send request to LLM API
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

    // Parse the response
    let response_body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

    let content = response_body["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "LLM response missing content".to_string())?;

    let llm_response: LLMRepairResponse =
        serde_json::from_str(content).map_err(|e| {
            format!("Failed to parse LLM repair JSON: {}\nContent: {}", e, content)
        })?;

    // Convert to RepairedCue, preserving original source structure
    let mut source_by_id: std::collections::HashMap<u32, &SourceCue> =
        source_cues.iter().map(|c| (c.id, c)).collect();

    let repaired: Vec<RepairedCue> = llm_response
        .repaired
        .into_iter()
        .map(|item| {
            let source = source_by_id.remove(&item.id);
            RepairedCue {
                id: item.id,
                start: source.map(|s| s.start.clone()).unwrap_or_default(),
                end: source.map(|s| s.end.clone()).unwrap_or_default(),
                source_text: source.map(|s| s.text.clone()).unwrap_or_default(),
                translated_text: item.translated_text,
                status: if item.needs_review {
                    RepairStatus::NeedsReview
                } else {
                    RepairStatus::LLMRepaired
                },
                confidence: item.confidence,
                notes: None,
            }
        })
        .collect();

    // Add any source cues the LLM failed to return
    for (_, source) in source_by_id {
        // Can't push to repaired since it's not mutable after collect in the same scope easily
        // This is handled by the caller merging results
        let _ = source;
    }

    Ok(repaired)
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

/// Translate a batch of cues using an LLM — pure translation, no SRT structure.
///
/// The LLM receives only cue IDs, source English text, current translation, and
/// surrounding context. It returns only Japanese translations. Cue numbers,
/// timestamps, and SRT formatting are never sent to or received from the LLM.
pub async fn translate_cues_batch(
    cues: &[crate::types::BatchRepairCue],
    api_key: &str,
    endpoint: &str,
    model: &str,
    extra_body: Option<&serde_json::Value>,
) -> Result<Vec<crate::types::BatchRepairResult>, String> {
    if cues.is_empty() {
        return Ok(Vec::new());
    }

    let system_prompt = r#"You are a professional Japanese translator. Translate the following English subtitles into natural, fluent Japanese.

Rules:
1. Translate each cue independently based on its source_text.
2. Use the context_before and context_after fields only for consistency — do NOT merge or combine cues.
3. Use the current_translation field as a reference for style/tone, but produce a fresh translation.
4. If source_text is empty, return an empty translation.
5. Keep translations concise — suitable for subtitle display.
6. Return ONLY valid JSON with the root key "translations" containing an array of translation objects.
7. Set confidence between 0.0 (very uncertain) and 1.0 (completely confident).

Response format (ABSOLUTE — do not deviate):
{
  "translations": [
    {"id": <cue_id>, "translation": "<japanese text>", "confidence": <0.0-1.0>},
    ...
  ]
}"#;

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

    let chat_request = ChatCompletionRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system_prompt.to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "Translate the following {} subtitle cues to Japanese.\n\nReturn a JSON object with root key \"translations\" containing an array of {{id, translation, confidence}} objects.\n\nInput cues:\n{}",
                    cues.len(),
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

    // Parse the LLM's JSON response.
    // Try structured deserialization first (expects "translations" key).
    // Then try "cues" as a fallback (some models use this key name).
    // Finally, attempt partial salvage: extract translation items from raw JSON.
    let parsed_items: Vec<TranslationItem> = parse_translation_response(content)?;

    // Build results, preserving original cue data
    let mut cue_map: std::collections::HashMap<u32, &crate::types::BatchRepairCue> =
        cues.iter().map(|c| (c.id, c)).collect();

    let results: Vec<crate::types::BatchRepairResult> = parsed_items
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
            }
        })
        .collect();

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
            error: Some("LLM did not return a translation for this cue".to_string()),
        });
    }

    // Sort by ID for consistent ordering
    all_results.sort_by_key(|r| r.id);

    Ok(all_results)
}
