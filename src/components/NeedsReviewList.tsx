import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RepairedCue, BatchRepairResult } from "../types";

interface NeedsReviewListProps {
  cues: RepairedCue[];
  /** All repaired cues (for building context when retrying a single cue) */
  repairedCues: RepairedCue[];
  /** Called when any individual AI retry succeeds */
  onRetrySuccess: () => void;
}

export default function NeedsReviewList({ cues, repairedCues, onRetrySuccess }: NeedsReviewListProps) {
  // Track per-cue retry state: cue_id → BatchRepairResult | "loading"
  const [retryState, setRetryState] = useState<
    Map<number, BatchRepairResult | "loading">
  >(new Map());

  const handleRetryCue = useCallback(
    async (cue: RepairedCue, cueIndex: number) => {
      // Don't retry if no source text
      if (!cue.source_text) return;

      setRetryState((prev) => {
        const next = new Map(prev);
        next.set(cue.id, "loading");
        return next;
      });

      // Build context from surrounding cues
      const contextBefore =
        cueIndex > 0
          ? (repairedCues[cueIndex - 1]?.source_text ?? "")
          : "";
      const contextAfter =
        cueIndex < repairedCues.length - 1
          ? (repairedCues[cueIndex + 1]?.source_text ?? "")
          : "";

      try {
        const results = await invoke<BatchRepairResult[]>(
          "batch_translate_cues",
          {
            cues: [
              {
                id: cue.id,
                source_text: cue.source_text,
                current_translation: cue.translated_text,
                context_before: contextBefore,
                context_after: contextAfter,
              },
            ],
            batchSize: 1,
          },
        );

        const result = results[0];
        if (result) {
          if (!result.error && result.llm_translation) {
            onRetrySuccess();
          }
          setRetryState((prev) => {
            const next = new Map(prev);
            next.set(cue.id, result);
            return next;
          });
        }
      } catch (e) {
        setRetryState((prev) => {
          const next = new Map(prev);
          next.set(cue.id, {
            id: cue.id,
            source_text: cue.source_text,
            original_translation: cue.translated_text,
            llm_translation: "",
            confidence: 0,
            status: "Pending" as const,
            error: String(e),
          });
          return next;
        });
      }
    },
    [repairedCues],
  );

  // Check if a cue is eligible for single-cue LLM retry:
  // source text exists AND (translation is empty OR LLM failed)
  const isEligibleForRetry = (cue: RepairedCue): boolean => {
    if (!cue.source_text) return false;
    if (!cue.translated_text) return true;
    if (cue.notes?.startsWith("LLM repair failed")) return true;
    return false;
  };

  return (
    <section className="needs-review">
      <h2>確認が必要な字幕 ({cues.length}件)</h2>
      <p className="review-hint">
        以下の字幕は自動修復できませんでした。
        翻訳がない字幕は「AIで修正」ボタンで個別にAI翻訳を試すことができます。
      </p>

      <div className="review-list">
        {cues.map((cue, idx) => {
          const retryResult = retryState.get(cue.id);
          const isLoading = retryResult === "loading";
          const eligible = isEligibleForRetry(cue);

          // Show the most recent error state: prefer retry result error over stale notes
          const retrySucceeded =
            retryResult &&
            retryResult !== "loading" &&
            !retryResult.error &&
            retryResult.llm_translation;
          const retryFailed =
            retryResult && retryResult !== "loading" && retryResult.error;

          // Suppress old "AI repair failed" notes when retry succeeded
          const displayNotes =
            retrySucceeded
              ? `AI個別修正済 (確度: ${(retryResult.confidence * 100).toFixed(0)}%)`
              : !retryFailed && cue.notes?.startsWith("AI repair failed")
              ? cue.notes  // Still show if not retried yet
              : !retryFailed
              ? cue.notes
              : undefined;

          return (
            <div key={cue.id} className="review-item">
              <div className="review-header">
                <span className="cue-id">字幕番号 {cue.id}</span>
                <span className="cue-time">
                  {cue.start} → {cue.end}
                </span>
              </div>

              <div className="review-body">
                <div className="review-compare">
                  <div className="review-original">
                    <label className="compare-label">翻訳前</label>
                    <p>{cue.source_text || <em className="empty-text">（空）</em>}</p>
                  </div>

                  <div className="review-translated">
                    <label className="compare-label">翻訳後</label>
                    <p>
                      {cue.translated_text || (
                        <em className="empty-text">（翻訳なし）</em>
                      )}
                    </p>
                  </div>
                </div>

                {/* LLM retry in flight */}
                {isLoading && (
                  <div className="review-llm-loading">AI翻訳中...</div>
                )}

                {/* LLM retry result */}
                {retryResult && retryResult !== "loading" && (
                  <div className="review-llm-result">
                    <label>AI翻訳候補:</label>
                    {retryResult.error ? (
                      <p className="error-text">{retryResult.error}</p>
                    ) : (
                      <>
                        <p>{retryResult.llm_translation || <em className="empty-text">（なし）</em>}</p>
                        <span className="review-confidence">
                          確度: {(retryResult.confidence * 100).toFixed(0)}%
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>

              {displayNotes && (
                <div className="review-notes">
                  <span className="note-label">備考: </span>
                  {displayNotes}
                </div>
              )}
              {retryFailed && (
                <div className="review-notes review-notes-error">
                  <span className="note-label">エラー: </span>
                  {retryResult.error}
                </div>
              )}

              <div className="review-footer">
                <div className="review-status">
                  状態:{" "}
                  <span className={`status-${cue.status.toLowerCase()}`}>
                    {cue.status === "NeedsReview" && "確認が必要"}
                    {cue.status === "Unmatched" && "未一致"}
                    {cue.status === "LLMRepaired" && "AI修復済"}
                    {cue.status === "AutoMatched" && "自動一致"}
                    {cue.status === "StructureRecovered" && "構造修復"}
                  </span>
                  {cue.confidence > 0 &&
                    ` (確度: ${(cue.confidence * 100).toFixed(0)}%)`}
                </div>

                {eligible && (
                  <button
                    className="cue-retry-btn"
                    disabled={isLoading}
                    onClick={() => handleRetryCue(cue, idx)}
                  >
                    {isLoading ? "修正中..." : "AIで修正"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
