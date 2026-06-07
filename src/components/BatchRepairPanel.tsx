import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BatchRepairCue,
  BatchRepairResult,
  BatchCueStatus,
  LlmConfig,
} from "../types";

// ── State machine ──────────────────────────────────────────────────────────
type PanelState = "idle" | "testing" | "repairing" | "previewing" | "saving";

// ── Props ──────────────────────────────────────────────────────────────────
interface BatchRepairPanelProps {
  targetCues: BatchRepairCue[];
  llmConfig: LlmConfig | null;
  llmConfigured: boolean;
  translatedFileName: string | null;
  onSave: (accepted: BatchRepairResult[], outputDir?: string) => Promise<string>;
  onConnectionSuccess: () => void;
}

export default function BatchRepairPanel({
  targetCues,
  llmConfig,
  llmConfigured,
  translatedFileName,
  onSave,
  onConnectionSuccess,
}: BatchRepairPanelProps) {
  // ── State ──────────────────────────────────────────────────────────────
  const [panelState, setPanelState] = useState<PanelState>("idle");
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [repairResults, setRepairResults] = useState<BatchRepairResult[]>([]);
  const [repairProgress, setRepairProgress] = useState<{
    batch: number;
    totalBatches: number;
    done: number;
    total: number;
  } | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [savedSrtPath, setSavedSrtPath] = useState<string | null>(null);
  const [predictedPath, setPredictedPath] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [batchSize, setBatchSize] = useState(15);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  // ── Fetch predicted save path on mount / outputDir change ──────────────
  useEffect(() => {
    if (translatedFileName) {
      invoke<string>("predict_llm_output_path", {
        translatedFileName,
        outputDir,
      }).then(setPredictedPath);
    }
  }, [translatedFileName, outputDir]);

  // ── Connection test ────────────────────────────────────────────────────
  const handleTestConnection = useCallback(async () => {
    if (!llmConfig?.configured) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await invoke<string>("test_llm_connection", {
        baseUrl: llmConfig.base_url,
        model: llmConfig.model,
        apiKeyEnv: llmConfig.api_key_env,
        apiKeyFallback: null,
      });
      setTestResult({ success: true, message: result });
      onConnectionSuccess();
    } catch (e) {
      setTestResult({ success: false, message: String(e) });
    } finally {
      setTestLoading(false);
    }
  }, [llmConfig, onConnectionSuccess]);

  // ── Batch repair (frontend-driven batching for cancel support) ─────────
  const handleBatchRepair = useCallback(async () => {
    setPanelState("repairing");
    setRepairError(null);
    setRepairResults([]);
    setSavedSrtPath(null);
    cancelledRef.current = false;

    const totalBatches = Math.ceil(targetCues.length / batchSize);
    setRepairProgress({ batch: 0, totalBatches, done: 0, total: targetCues.length });

    const allResults: BatchRepairResult[] = [];
    let cumulativeDone = 0;

    for (let i = 0; i < totalBatches; i++) {
      if (cancelledRef.current) {
        for (let j = i * batchSize; j < targetCues.length; j++) {
          const cue = targetCues[j];
          allResults.push({
            id: cue.id,
            source_text: cue.source_text,
            original_translation: cue.current_translation,
            llm_translation: "",
            confidence: 0,
            status: "Pending" as BatchCueStatus,
            error: "キャンセルされました",
          });
        }
        break;
      }

      const chunk = targetCues.slice(i * batchSize, (i + 1) * batchSize);
      setRepairProgress({ batch: i + 1, totalBatches, done: cumulativeDone, total: targetCues.length });

      try {
        const results = await invoke<BatchRepairResult[]>(
          "batch_translate_cues",
          { cues: chunk, batchSize },
        );
        allResults.push(...results);
        cumulativeDone += chunk.length;
        setRepairProgress({ batch: i + 1, totalBatches, done: cumulativeDone, total: targetCues.length });
      } catch (e) {
        for (const cue of chunk) {
          allResults.push({
            id: cue.id,
            source_text: cue.source_text,
            original_translation: cue.current_translation,
            llm_translation: "",
            confidence: 0,
            status: "Pending" as BatchCueStatus,
            error: `バッチ ${i + 1} 失敗: ${String(e)}`,
          });
        }
        cumulativeDone += chunk.length;
      }
    }

    allResults.sort((a, b) => a.id - b.id);
    setRepairResults(allResults);
    setRepairProgress(null);
    setPanelState("previewing");
  }, [targetCues, batchSize]);

  const handleCancelRepair = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  // ── Preview actions ────────────────────────────────────────────────────
  const handleToggleCue = useCallback((id: number) => {
    setRepairResults((prev) =>
      prev.map((r) => {
        if (r.id !== id) return r;
        const next: BatchCueStatus =
          r.status === "Accepted" ? "Rejected" : "Accepted";
        return { ...r, status: next };
      })
    );
  }, []);

  const handleAcceptAll = useCallback(() => {
    setRepairResults((prev) =>
      prev.map((r) => ({
        ...r,
        status: (r.error && !r.llm_translation ? "Rejected" : "Accepted") as BatchCueStatus,
      }))
    );
  }, []);

  const handleRejectAll = useCallback(() => {
    setRepairResults((prev) =>
      prev.map((r) => ({ ...r, status: "Rejected" as BatchCueStatus }))
    );
  }, []);

  // ── Retry failed batch ─────────────────────────────────────────────────
  const handleRetryFailed = useCallback(async () => {
    const failedCues = repairResults
      .filter((r) => r.error && !r.llm_translation)
      .map((r) => targetCues.find((c) => c.id === r.id)!)
      .filter(Boolean);

    if (failedCues.length === 0) return;

    setPanelState("repairing");
    setRepairError(null);
    cancelledRef.current = false;

    const totalBatches = Math.ceil(failedCues.length / batchSize);
    setRepairProgress({ batch: 0, totalBatches, done: 0, total: failedCues.length });

    let cumulativeDone = 0;

    for (let i = 0; i < totalBatches; i++) {
      if (cancelledRef.current) break;
      const chunk = failedCues.slice(i * batchSize, (i + 1) * batchSize);
      setRepairProgress({ batch: i + 1, totalBatches, done: cumulativeDone, total: failedCues.length });

      try {
        const results = await invoke<BatchRepairResult[]>(
          "batch_translate_cues",
          { cues: chunk, batchSize },
        );
        const retryMap = new Map(results.map((r) => [r.id, r]));
        setRepairResults((prev) =>
          prev.map((r) => {
            const retry = retryMap.get(r.id);
            if (retry && !retry.error && retry.llm_translation) {
              return { ...r, ...retry, error: undefined, status: "Pending" as BatchCueStatus };
            }
            return r;
          })
        );
        cumulativeDone += chunk.length;
      } catch (_e) {
        cumulativeDone += chunk.length;
      }
    }

    setRepairProgress(null);
    setPanelState("previewing");
  }, [repairResults, targetCues, batchSize]);

  // ── Save ───────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const accepted = repairResults.filter((r) => r.status === "Accepted");
    if (accepted.length === 0) return;

    setPanelState("saving");
    try {
      const path = await onSave(accepted, outputDir ?? undefined);
      setSavedSrtPath(path);
      setPanelState("previewing");
    } catch (e) {
      setRepairError(String(e));
      setPanelState("previewing");
    }
  }, [repairResults, onSave]);

  const handleDiscard = useCallback(() => {
    setPanelState("idle");
    setRepairResults([]);
    setSavedSrtPath(null);
    setRepairError(null);
  }, []);

  // ── Post-save actions ──────────────────────────────────────────────────
  const handleOpenFile = useCallback(async () => {
    if (savedSrtPath) {
      await invoke("open_file", { path: savedSrtPath });
    }
  }, [savedSrtPath]);

  const handleOpenFolder = useCallback(async () => {
    if (savedSrtPath) {
      await invoke("open_folder", { path: savedSrtPath });
    }
  }, [savedSrtPath]);

  const handleCopyPath = useCallback(async () => {
    if (savedSrtPath) {
      await invoke("copy_to_clipboard", { text: savedSrtPath });
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  }, [savedSrtPath]);

  // ── Folder picker for output directory ──────────────────────────────────
  const handleChangeFolder = useCallback(async () => {
    const selected = await open({ directory: true, title: "保存先フォルダを選択" });
    if (selected && typeof selected === "string") {
      setOutputDir(selected);
    }
  }, []);

  // ── Compute stats ──────────────────────────────────────────────────────
  const acceptedCount = repairResults.filter((r) => r.status === "Accepted").length;
  const rejectedCount = repairResults.filter((r) => r.status === "Rejected").length;
  const pendingCount = repairResults.filter((r) => r.status === "Pending").length;
  const errorCount = repairResults.filter((r) => r.error).length;
  const batchCount = Math.ceil(targetCues.length / batchSize);

  const eligibleCues = useMemo(
    () => targetCues.filter((c) => c.source_text && !c.current_translation),
    [targetCues]
  );

  const canStartBatch = llmConfigured && eligibleCues.length > 0;
  const hasSaved = savedSrtPath != null;

  // ── Cancel button text depends on state ────────────────────────────────
  const cancelLabel =
    panelState === "repairing" ? "中止" : hasSaved ? "閉じる" : "AI修正結果を破棄";

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <section id="batch-repair-panel" className="batch-repair-panel">
      <h2>一括AI修正</h2>

      {eligibleCues.length === 0 && panelState === "idle" && (
        <p className="batch-hint">翻訳欠落のある字幕はありません。</p>
      )}

      {eligibleCues.length > 0 && panelState === "idle" && (
        <p className="batch-hint">
          {eligibleCues.length}件の字幕に翻訳が不足しています（全{batchCount}バッチ）。
          AIで一括翻訳を補完できます。
        </p>
      )}

      {/* ── Idle / Testing ─────────────────────────────────────────── */}
      {(panelState === "idle" || panelState === "testing") && (
        <div className="batch-controls">
          {/* AI connection status */}
          {llmConfigured && llmConfig && (
            <div className="ai-connection-status">
              <span className="ai-status-dot configured" />
              <span className="ai-status-text">
                {llmConfig.provider !== "custom"
                  ? `${llmConfig.provider} · ${llmConfig.model}`
                  : `カスタム · ${llmConfig.model || "（モデル未設定）"}`}
                {" "}接続済み
              </span>
            </div>
          )}
          {!llmConfigured && (
            <div className="ai-connection-status not-configured">
              <span className="ai-status-dot" />
              <span className="ai-status-text">
                AI接続未確認 — 必要に応じて「AI接続テスト」を実行してください。
              </span>
            </div>
          )}

          <div className="batch-control-row">
            <button
              className="test-btn"
              onClick={handleTestConnection}
              disabled={!llmConfigured || testLoading}
            >
              {testLoading ? "テスト中..." : "AI接続テスト"}
            </button>

            <button
              className="repair-button"
              disabled={!canStartBatch}
              onClick={handleBatchRepair}
            >
              未翻訳{eligibleCues.length}件をAIで補完
            </button>
          </div>

          <p className="batch-note">
            AI翻訳はすぐにSRTへ反映されません。翻訳候補を確認し、採用したものだけを新しいSRTに保存します。
          </p>

          <div className="batch-size-row">
            <label>
              バッチサイズ:
              <select
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                className="batch-size-select"
              >
                <option value={5}>5件</option>
                <option value={10}>10件</option>
                <option value={15}>15件</option>
                <option value={20}>20件</option>
              </select>
            </label>
          </div>

          {testResult && (
            <div
              className={`connection-test-result ${
                testResult.success ? "test-success" : "test-error"
              }`}
            >
              {testResult.success ? "✅ " : "❌ "}
              {testResult.message}
            </div>
          )}
        </div>
      )}

      {/* ── Repairing ───────────────────────────────────────────────── */}
      {panelState === "repairing" && repairProgress && (
        <div className="batch-progress">
          <div className="batch-progress-bar">
            <div
              className="batch-progress-fill"
              style={{
                width: `${Math.round(
                  (repairProgress.done / Math.max(repairProgress.total, 1)) * 100
                )}%`,
              }}
            />
          </div>
          <div className="batch-progress-detail">
            <span className="batch-progress-text">
              バッチ {repairProgress.batch}/{repairProgress.totalBatches} を処理中
            </span>
            <span className="batch-progress-sub">
              字幕 {repairProgress.done}/{repairProgress.total} 件完了
            </span>
          </div>
          <button className="cue-retry-btn" onClick={handleCancelRepair}>
            中止
          </button>
        </div>
      )}

      {/* ── Error message ───────────────────────────────────────────── */}
      {repairError && (
        <div className="error-banner">
          <p>{repairError}</p>
        </div>
      )}

      {/* ── Previewing ──────────────────────────────────────────────── */}
      {panelState === "previewing" && (
        <div className="batch-preview">
          <div className="batch-preview-header">
            <span>
              {repairResults.length}件の翻訳候補（
              採用: {acceptedCount} / 却下: {rejectedCount} / 未確認:{" "}
              {pendingCount}
              {errorCount > 0 && ` / エラー: ${errorCount}`}）
            </span>
            <div className="batch-actions">
              <button className="link-btn" onClick={handleAcceptAll}>
                すべて選択
              </button>
              <button className="link-btn" onClick={handleRejectAll}>
                すべて解除
              </button>
              {errorCount > 0 && (
                <button className="test-btn" onClick={handleRetryFailed}>
                  失敗分を再試行 ({errorCount}件)
                </button>
              )}
            </div>
          </div>

          {errorCount > 0 && (
            <details className="batch-error-details">
              <summary>エラー詳細（{errorCount}件）</summary>
              <ul>
                {repairResults
                  .filter((r) => r.error)
                  .map((r) => (
                    <li key={r.id}>
                      <strong>#{r.id}</strong>: {r.error}
                      {r.source_text && (
                        <span className="batch-error-context">
                          {" "}— {r.source_text.substring(0, 60)}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
            </details>
          )}

          <div className="batch-preview-table-wrapper">
            <table className="batch-preview-table">
              <thead>
                <tr>
                  <th className="col-id">#</th>
                  <th className="col-source">英語</th>
                  <th className="col-original">現在の訳</th>
                  <th className="col-llm">AI翻訳</th>
                  <th className="col-conf">確度</th>
                  <th className="col-toggle">採用</th>
                </tr>
              </thead>
              <tbody>
                {repairResults.map((r) => (
                  <tr
                    key={r.id}
                    className={
                      r.status === "Accepted"
                        ? "row-accepted"
                        : r.status === "Rejected"
                        ? "row-rejected"
                        : r.error
                        ? "row-error"
                        : ""
                    }
                  >
                    <td className="col-id">{r.id}</td>
                    <td className="col-source">{r.source_text}</td>
                    <td className="col-original">
                      {r.original_translation || <em className="empty-text">（なし）</em>}
                    </td>
                    <td className="col-llm">
                      {r.error && !r.llm_translation ? (
                        <span className="error-text">{r.error}</span>
                      ) : (
                        r.llm_translation || <em className="empty-text">（なし）</em>
                      )}
                    </td>
                    <td className="col-conf">
                      {r.error && !r.llm_translation
                        ? "-"
                        : `${(r.confidence * 100).toFixed(0)}%`}
                    </td>
                    <td className="col-toggle">
                      <button
                        className={`toggle-btn ${
                          r.status === "Accepted" ? "toggle-on" : "toggle-off"
                        }`}
                        onClick={() => handleToggleCue(r.id)}
                        disabled={!!r.error && !r.llm_translation}
                      >
                        {r.status === "Accepted" ? "採用" : "却下"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Save info ──────────────────────────────────────────── */}
          <div className="batch-save-info">
            <p className="save-info-text">
              採用されたAI翻訳だけを反映し、元のSRTは変更せずに新しいSRTファイルを作成します。
            </p>
            {predictedPath && !hasSaved && (
              <div className="save-dest-row">
                <p className="save-dest-path">
                  保存先: <code>{predictedPath}</code>
                </p>
                <button className="link-btn" onClick={handleChangeFolder}>
                  フォルダを変更
                </button>
              </div>
            )}
          </div>

          {/* ── Save / Saved actions ────────────────────────────────── */}
          <div className="batch-save-row">
            {!hasSaved ? (
              <button
                className="repair-button"
                disabled={acceptedCount === 0}
                onClick={handleSave}
              >
                選択した{acceptedCount}件を新しいSRTに保存
              </button>
            ) : (
              <button className="repair-button" disabled>
                保存済み
              </button>
            )}
            <button className="close-btn modal-btn" onClick={handleDiscard}>
              {cancelLabel}
            </button>
          </div>

          {/* ── Post-save success ──────────────────────────────────── */}
          {hasSaved && (
            <div className="batch-save-success">
              <div className="save-success-banner">
                ✅ AI修正済みSRTを作成しました。
              </div>
              <div className="output-path">
                <code className="output-value">{savedSrtPath}</code>
              </div>
              <div className="save-actions">
                <button className="modal-btn save-btn" onClick={handleOpenFile}>
                  ファイルを開く
                </button>
                <button className="modal-btn" onClick={handleOpenFolder}>
                  フォルダを開く
                </button>
                <button className="modal-btn" onClick={handleCopyPath}>
                  {copyFeedback ? "コピーしました" : "パスをコピー"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Saving ──────────────────────────────────────────────────── */}
      {panelState === "saving" && (
        <div className="batch-saving">
          <p>保存中...</p>
        </div>
      )}
    </section>
  );
}
