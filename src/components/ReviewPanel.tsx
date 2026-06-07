import {
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useEffect,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ReviewCue,
  ReviewCueStatus,
  RepairedCue,
  BatchRepairCue,
  BatchRepairResult,
  LlmConfig,
} from "../types";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Truncate text for table cell display. */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// ── Reducer ────────────────────────────────────────────────────────────────

type FilterTab =
  | "all"
  | "candidate"
  | "unreviewed"
  | "accepted"
  | "rejected"
  | "error"
  | "empty";

type BatchState =
  | { phase: "idle" }
  | { phase: "repairing"; batch: number; totalBatches: number; done: number; total: number }
  | { phase: "done" };

interface PanelState {
  cues: ReviewCue[];
  filter: FilterTab;
  selectedId: number | null;
  batchState: BatchState;
  savedPath: string | null;
  outputDir: string | null;
  batchSize: number;
  copyFeedback: boolean;
}

type PanelAction =
  | { type: "SELECT_CUE"; id: number | null }
  | { type: "TOGGLE_ACCEPT"; id: number }
  | { type: "REJECT_CUE"; id: number }
  | { type: "SET_FILTER"; filter: FilterTab }
  | { type: "SET_AI_RESULT"; id: number; translation: string; confidence: number }
  | { type: "SET_AI_ERROR"; id: number; error: string }
  | { type: "SET_AI_LOADING"; id: number }
  | { type: "MERGE_BATCH_RESULTS"; results: BatchRepairResult[] }
  | { type: "SET_EDITED_TRANSLATION"; id: number; text: string }
  | { type: "TOGGLE_SELECT_ALL" }
  | { type: "ACCEPT_ALL_CANDIDATES" }
  | { type: "DESELECT_ALL" }
  | { type: "SET_SAVED_PATH"; path: string }
  | { type: "SET_BATCH_STATE"; state: BatchState }
  | { type: "SET_OUTPUT_DIR"; dir: string | null }
  | { type: "SET_BATCH_SIZE"; size: number }
  | { type: "SET_COPY_FEEDBACK"; feedback: boolean }
  | { type: "NAVIGATE"; direction: "up" | "down" };

const emptyBatchState: BatchState = { phase: "idle" };

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "SELECT_CUE":
      return { ...state, selectedId: action.id };

    case "TOGGLE_ACCEPT": {
      const cues = state.cues.map((c) => {
        if (c.id !== action.id) return c;
        const next =
          c.status === "accepted" ? "unreviewed" : "accepted";
        const sel = next === "accepted";
        let { note } = c;
        // Clear error notes when accepting
        if (sel && (note.startsWith("LLM repair failed") || note.startsWith("AI repair failed"))) {
          note = next === "accepted" ? "採用済み" : note;
        }
        return {
          ...c,
          status: next as ReviewCueStatus,
          selected: sel,
          note: sel && !c.note ? "採用済み" : note,
        };
      });
      return { ...state, cues };
    }

    case "REJECT_CUE": {
      const cues = state.cues.map((c) => {
        if (c.id !== action.id) return c;
        return { ...c, status: "rejected" as ReviewCueStatus, selected: false, note: "却下" };
      });
      return { ...state, cues };
    }

    case "SET_FILTER":
      return { ...state, filter: action.filter, selectedId: null };

    case "SET_AI_LOADING": {
      const cues = state.cues.map((c) => {
        if (c.id !== action.id) return c;
        return { ...c, aiTranslation: "", confidence: 0, error: "", note: "AI翻訳中..." };
      });
      return { ...state, cues };
    }

    case "SET_AI_RESULT": {
      const cues = state.cues.map((c) => {
        if (c.id !== action.id) return c;
        return {
          ...c,
          aiTranslation: action.translation,
          confidence: action.confidence,
          status: "ai_individual_repaired" as ReviewCueStatus,
          error: "",
          note: `AI個別修正済（確度: ${(action.confidence * 100).toFixed(0)}%）`,
        };
      });
      return { ...state, cues };
    }

    case "SET_AI_ERROR": {
      const cues = state.cues.map((c) => {
        if (c.id !== action.id) return c;
        return {
          ...c,
          aiTranslation: "",
          confidence: 0,
          status: "error" as ReviewCueStatus,
          error: action.error,
          note: `LLM repair failed: ${action.error}`,
        };
      });
      return { ...state, cues };
    }

    case "MERGE_BATCH_RESULTS": {
      const resultMap = new Map(action.results.map((r) => [r.id, r]));
      const cues = state.cues.map((c) => {
        const r = resultMap.get(c.id);
        if (!r) return c;
        if (r.error && !r.llm_translation) {
          return {
            ...c,
            status: "error" as ReviewCueStatus,
            error: r.error || "",
            note: `LLM repair failed: ${r.error || ""}`,
          };
        }
        return {
          ...c,
          aiTranslation: r.llm_translation,
          confidence: r.confidence,
          status: "ai_batch_repaired" as ReviewCueStatus,
          error: "",
          note: r.llm_translation
            ? `一括AI修正済（確度: ${(r.confidence * 100).toFixed(0)}%）`
            : c.note,
        };
      });
      return { ...state, cues };
    }

    case "SET_EDITED_TRANSLATION": {
      const cues = state.cues.map((c) => {
        if (c.id !== action.id) return c;
        return {
          ...c,
          editedTranslation: action.text,
          userEdited: action.text !== c.aiTranslation,
          status: action.text ? ("candidate_edited" as ReviewCueStatus) : c.status,
        };
      });
      return { ...state, cues };
    }

    case "TOGGLE_SELECT_ALL": {
      const allSelected = state.cues.every((c) => c.selected);
      const cues = state.cues.map((c) => ({
        ...c,
        selected: !allSelected,
      }));
      return { ...state, cues };
    }

    case "DESELECT_ALL": {
      const cues = state.cues.map((c) => ({ ...c, selected: false }));
      return { ...state, cues };
    }

    case "ACCEPT_ALL_CANDIDATES": {
      const cues = state.cues.map((c) => {
        if (
          c.aiTranslation &&
          !c.error &&
          c.status !== "accepted" &&
          c.status !== "rejected"
        ) {
          return {
            ...c,
            status: "accepted" as ReviewCueStatus,
            selected: true,
            note: `一括採用（確度: ${(c.confidence * 100).toFixed(0)}%）`,
          };
        }
        return c;
      });
      return { ...state, cues };
    }

    case "SET_SAVED_PATH":
      return { ...state, savedPath: action.path };

    case "SET_BATCH_STATE":
      return { ...state, batchState: action.state };

    case "SET_OUTPUT_DIR":
      return { ...state, outputDir: action.dir };

    case "SET_BATCH_SIZE":
      return { ...state, batchSize: action.size };

    case "SET_COPY_FEEDBACK":
      return { ...state, copyFeedback: action.feedback };

    case "NAVIGATE": {
      const filtered = getFilteredCues(state.cues, state.filter);
      if (filtered.length === 0) return state;
      const curIdx = filtered.findIndex((c) => c.id === state.selectedId);
      const nextIdx =
        action.direction === "up"
          ? Math.max(0, curIdx - 1)
          : Math.min(filtered.length - 1, curIdx === -1 ? 0 : curIdx + 1);
      return { ...state, selectedId: filtered[nextIdx]?.id ?? state.selectedId };
    }

    default:
      return state;
  }
}

function getFilteredCues(cues: ReviewCue[], filter: FilterTab): ReviewCue[] {
  switch (filter) {
    case "all":
      return cues;
    case "candidate":
      return cues.filter((c) =>
        ["candidate", "ai_individual_repaired", "ai_batch_repaired", "candidate_edited"].includes(c.status)
      );
    case "unreviewed":
      return cues.filter((c) => ["unreviewed", "needs_review"].includes(c.status));
    case "accepted":
      return cues.filter((c) => c.status === "accepted");
    case "rejected":
      return cues.filter((c) => c.status === "rejected");
    case "error":
      return cues.filter((c) => c.status === "error");
    case "empty":
      return cues.filter((c) => c.status === "empty");
  }
}

// ── Props ──────────────────────────────────────────────────────────────────

interface ReviewPanelProps {
  initialCues: ReviewCue[];
  repairedCues: RepairedCue[];
  llmConfig: LlmConfig | null;
  llmConfigured: boolean;
  aiConnectionOk: boolean;
  translatedFileName: string | null;
  onSave: (accepted: BatchRepairResult[], outputDir?: string) => Promise<string>;
  onConnectionSuccess: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ReviewPanel({
  initialCues,
  repairedCues,
  llmConfig: _llmConfig,
  llmConfigured: _llmConfigured,
  aiConnectionOk,
  translatedFileName: _translatedFileName,
  onSave,
  onConnectionSuccess,
}: ReviewPanelProps) {
  const [state, dispatch] = useReducer(panelReducer, {
    cues: initialCues,
    filter: "all",
    selectedId: null,
    batchState: emptyBatchState,
    savedPath: null,
    outputDir: null,
    batchSize: 15,
    copyFeedback: false,
  });

  // Sync initialCues when they change (e.g., new repair)
  const prevInitialRef = useRef(initialCues);
  useEffect(() => {
    if (prevInitialRef.current !== initialCues) {
      prevInitialRef.current = initialCues;
      // Full reset — replace cues entirely
      dispatch({
        type: "SELECT_CUE",
        id: null,
      } as PanelAction);
      // Force re-init by dispatching a reset
      // We handle this via key prop in App.tsx, so this is just a safeguard
    }
  }, [initialCues]);

  const cancelledRef = useRef(false);
  const detailRef = useRef<HTMLDivElement>(null);

  // ── Derived values ─────────────────────────────────────────────────────
  const filteredCues = useMemo(
    () => getFilteredCues(state.cues, state.filter),
    [state.cues, state.filter]
  );

  const selectedCue = useMemo(
    () => state.cues.find((c) => c.id === state.selectedId) ?? null,
    [state.cues, state.selectedId]
  );

  const counts = useMemo(() => {
    const c = state.cues;
    return {
      total: c.length,
      aiEligible: c.filter((x) => x.isAiRepairable).length,
      emptySource: c.filter((x) => x.status === "empty").length,
      other: c.filter(
        (x) => !x.isAiRepairable && x.status !== "empty" && x.status !== "accepted" && x.status !== "rejected"
      ).length,
      candidate: c.filter((x) =>
        ["candidate", "ai_individual_repaired", "ai_batch_repaired", "candidate_edited"].includes(x.status)
      ).length,
      accepted: c.filter((x) => x.status === "accepted").length,
      rejected: c.filter((x) => x.status === "rejected").length,
      unreviewed: c.filter((x) =>
        ["unreviewed", "needs_review"].includes(x.status)
      ).length,
    };
  }, [state.cues]);

  const acceptedCues = useMemo(
    () => state.cues.filter((c) => c.status === "accepted"),
    [state.cues]
  );

  // ── Filter tabs ────────────────────────────────────────────────────────
  const filterTabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "すべて", count: counts.total },
    { key: "candidate", label: "AI候補あり", count: counts.candidate },
    { key: "unreviewed", label: "未確認", count: counts.unreviewed },
    { key: "accepted", label: "採用済み", count: counts.accepted },
    { key: "rejected", label: "却下", count: counts.rejected },
    { key: "error", label: "エラー", count: state.cues.filter((c) => c.status === "error").length },
    { key: "empty", label: "空字幕", count: counts.emptySource },
  ];

  // ── Status display ─────────────────────────────────────────────────────
  const statusLabel = (s: ReviewCueStatus): string => {
    switch (s) {
      case "unreviewed": return "未確認";
      case "needs_review": return "確認が必要";
      case "candidate": return "AI候補あり";
      case "ai_individual_repaired": return "AI個別修正済";
      case "ai_batch_repaired": return "一括AI修正済";
      case "candidate_edited": return "編集済候補";
      case "accepted": return "採用済み";
      case "rejected": return "却下";
      case "empty": return "空字幕";
      case "error": return "エラー";
    }
  };

  // ── Row class ──────────────────────────────────────────────────────────
  const rowClass = (c: ReviewCue): string => {
    if (c.status === "accepted") return "row-accepted";
    if (c.status === "rejected" || c.status === "empty") return "row-rejected";
    if (c.status === "error") return "row-error";
    if (["candidate", "ai_individual_repaired", "ai_batch_repaired", "candidate_edited"].includes(c.status))
      return "row-candidate";
    return "";
  };

  // ── Individual AI repair ───────────────────────────────────────────────
  const handleAiRepair = useCallback(
    async (cue: ReviewCue) => {
      if (!cue.isAiRepairable) return;
      dispatch({ type: "SET_AI_LOADING", id: cue.id });

      // Build context from repairedCues
      const idx = repairedCues.findIndex((c) => c.id === cue.id);
      const contextBefore =
        idx > 0 ? (repairedCues[idx - 1]?.source_text ?? "") : "";
      const contextAfter =
        idx < repairedCues.length - 1
          ? (repairedCues[idx + 1]?.source_text ?? "")
          : "";

      try {
        const results = await invoke<BatchRepairResult[]>(
          "batch_translate_cues",
          {
            cues: [
              {
                id: cue.id,
                source_text: cue.sourceText,
                current_translation: cue.currentTranslation,
                context_before: contextBefore,
                context_after: contextAfter,
              },
            ],
            batchSize: 1,
          }
        );
        const r = results[0];
        if (r) {
          if (!r.error && r.llm_translation) {
            dispatch({
              type: "SET_AI_RESULT",
              id: cue.id,
              translation: r.llm_translation,
              confidence: r.confidence,
            });
            onConnectionSuccess();
          } else {
            dispatch({
              type: "SET_AI_ERROR",
              id: cue.id,
              error: r.error || "No translation returned",
            });
          }
        }
      } catch (e) {
        dispatch({ type: "SET_AI_ERROR", id: cue.id, error: String(e) });
      }
    },
    [repairedCues, onConnectionSuccess]
  );

  // ── Batch AI repair ────────────────────────────────────────────────────
  const eligibleCues = useMemo(
    () => state.cues.filter((c) => c.isAiRepairable && c.status !== "accepted"),
    [state.cues]
  );

  const handleBatchRepair = useCallback(async () => {
    const targets = eligibleCues;
    if (targets.length === 0) return;

    dispatch({
      type: "SET_BATCH_STATE",
      state: { phase: "repairing", batch: 0, totalBatches: Math.ceil(targets.length / state.batchSize), done: 0, total: targets.length },
    });
    cancelledRef.current = false;

    const totalBatches = Math.ceil(targets.length / state.batchSize);
    let cumulativeDone = 0;

    for (let i = 0; i < totalBatches; i++) {
      if (cancelledRef.current) {
        // Mark remaining as cancelled
        const remaining = targets.slice(i * state.batchSize);
        const cancelledResults: BatchRepairResult[] = remaining.map((c) => ({
          id: c.id,
          source_text: c.sourceText,
          original_translation: c.currentTranslation,
          llm_translation: "",
          confidence: 0,
          status: "Pending" as const,
          error: "キャンセルされました",
        }));
        dispatch({ type: "MERGE_BATCH_RESULTS", results: cancelledResults });
        break;
      }

      const chunk = targets.slice(i * state.batchSize, (i + 1) * state.batchSize);
      dispatch({
        type: "SET_BATCH_STATE",
        state: { phase: "repairing", batch: i + 1, totalBatches, done: cumulativeDone, total: targets.length },
      });

      try {
        const batchCues: BatchRepairCue[] = chunk.map((c) => {
          const idx = repairedCues.findIndex((rc) => rc.id === c.id);
          return {
            id: c.id,
            source_text: c.sourceText,
            current_translation: c.currentTranslation,
            context_before: idx > 0 ? (repairedCues[idx - 1]?.source_text ?? "") : "",
            context_after: idx < repairedCues.length - 1 ? (repairedCues[idx + 1]?.source_text ?? "") : "",
          };
        });

        const results = await invoke<BatchRepairResult[]>(
          "batch_translate_cues",
          { cues: batchCues, batchSize: state.batchSize }
        );
        dispatch({ type: "MERGE_BATCH_RESULTS", results });
        cumulativeDone += chunk.length;
        onConnectionSuccess();
      } catch (e) {
        const errorResults: BatchRepairResult[] = chunk.map((c) => ({
          id: c.id,
          source_text: c.sourceText,
          original_translation: c.currentTranslation,
          llm_translation: "",
          confidence: 0,
          status: "Pending" as const,
          error: `バッチ ${i + 1} 失敗: ${String(e)}`,
        }));
        dispatch({ type: "MERGE_BATCH_RESULTS", results: errorResults });
        cumulativeDone += chunk.length;
      }
    }

    dispatch({ type: "SET_BATCH_STATE", state: { phase: "done" } });
  }, [eligibleCues, state.batchSize, repairedCues, onConnectionSuccess]);

  const handleCancelBatch = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  // ── Save ───────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (acceptedCues.length === 0) return;
    const batchResult: BatchRepairResult[] = acceptedCues.map((c) => ({
      id: c.id,
      source_text: c.sourceText,
      original_translation: c.currentTranslation,
      llm_translation: c.editedTranslation || c.aiTranslation || c.currentTranslation,
      confidence: c.confidence,
      status: "Accepted" as const,
    }));

    try {
      const path = await onSave(batchResult, state.outputDir ?? undefined);
      dispatch({ type: "SET_SAVED_PATH", path });
    } catch (e) {
      // Error handled by parent
    }
  }, [acceptedCues, state.outputDir, onSave]);

  // ── Post-save actions ──────────────────────────────────────────────────
  const handleOpenFile = useCallback(async () => {
    if (state.savedPath) await invoke("open_file", { path: state.savedPath });
  }, [state.savedPath]);

  const handleOpenFolder = useCallback(async () => {
    if (state.savedPath) await invoke("open_folder", { path: state.savedPath });
  }, [state.savedPath]);

  const handleCopyPath = useCallback(async () => {
    if (state.savedPath) {
      await invoke("copy_to_clipboard", { text: state.savedPath });
      dispatch({ type: "SET_COPY_FEEDBACK", feedback: true });
      setTimeout(() => dispatch({ type: "SET_COPY_FEEDBACK", feedback: false }), 2000);
    }
  }, [state.savedPath]);

  // ── Folder picker ──────────────────────────────────────────────────────
  const handleChangeFolder = useCallback(async () => {
    const selected = await open({ directory: true, title: "保存先フォルダを選択" });
    if (selected && typeof selected === "string") {
      dispatch({ type: "SET_OUTPUT_DIR", dir: selected });
    }
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only active when ReviewPanel is visible
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        if (selectedCue?.isAiRepairable) handleAiRepair(selectedCue);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        dispatch({ type: "NAVIGATE", direction: "up" });
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        dispatch({ type: "NAVIGATE", direction: "down" });
        return;
      }
      if (e.key === "Enter" && selectedCue) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_ACCEPT", id: selectedCue.id });
        return;
      }
      if (e.key === "Delete" && selectedCue) {
        e.preventDefault();
        dispatch({ type: "REJECT_CUE", id: selectedCue.id });
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedCue, handleSave, handleAiRepair]);

  // Scroll detail pane into view when a cue is selected
  useEffect(() => {
    if (state.selectedId && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [state.selectedId]);

  // ── Render ─────────────────────────────────────────────────────────────
  const canBatchRepair = aiConnectionOk && eligibleCues.length > 0;
  const hasSaved = state.savedPath !== null;

  return (
    <section className="review-panel">
      <h2>字幕レビュー</h2>

      {/* ═══════════════ Zone 1: Top Bar ═══════════════ */}
      <div className="review-topbar">
        <div className="review-counts">
          <span className="count-chip">確認が必要: {counts.total}件</span>
          <span className="count-chip count-ai">AI補完対象: {counts.aiEligible}件</span>
          {counts.emptySource > 0 && (
            <span className="count-chip count-empty">空字幕: {counts.emptySource}件</span>
          )}
          {counts.other > 0 && (
            <span className="count-chip count-other">その他: {counts.other}件</span>
          )}
          {counts.candidate > 0 && (
            <span className="count-chip count-candidate">AI候補あり: {counts.candidate}件</span>
          )}
          {counts.accepted > 0 && (
            <span className="count-chip count-accepted">採用済み: {counts.accepted}件</span>
          )}
          {counts.rejected > 0 && (
            <span className="count-chip count-rejected">却下: {counts.rejected}件</span>
          )}
          {counts.unreviewed > 0 && (
            <span className="count-chip count-unreviewed">未確認: {counts.unreviewed}件</span>
          )}
        </div>

        {/* Filter tabs */}
        <div className="review-filter-tabs">
          {filterTabs.map((t) => (
            <button
              key={t.key}
              className={`review-filter-tab${state.filter === t.key ? " active" : ""}`}
              onClick={() => dispatch({ type: "SET_FILTER", filter: t.key })}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>

        {/* Bulk actions */}
        <div className="review-bulk-actions">
          <button
            className="link-btn"
            onClick={() => dispatch({ type: "TOGGLE_SELECT_ALL" })}
          >
            すべて選択
          </button>
          <button
            className="link-btn"
            onClick={() => dispatch({ type: "DESELECT_ALL" })}
          >
            すべて解除
          </button>
          {counts.candidate > 0 && (
            <button
              className="link-btn"
              onClick={() => dispatch({ type: "ACCEPT_ALL_CANDIDATES" })}
            >
              AI候補ありをすべて採用
            </button>
          )}

          {/* Batch AI repair */}
          <div className="batch-repair-inline">
            <select
              className="batch-size-select"
              value={state.batchSize}
              onChange={(e) =>
                dispatch({ type: "SET_BATCH_SIZE", size: Number(e.target.value) })
              }
            >
              <option value={5}>5件</option>
              <option value={10}>10件</option>
              <option value={15}>15件</option>
              <option value={20}>20件</option>
            </select>
            <button
              className="repair-button"
              disabled={!canBatchRepair}
              onClick={handleBatchRepair}
            >
              未翻訳{eligibleCues.length}件をAIで補完
            </button>
          </div>
        </div>

        {/* Batch repair progress */}
        {state.batchState.phase === "repairing" && (
          <div className="batch-progress">
            <div className="batch-progress-bar">
              <div
                className="batch-progress-fill"
                style={{
                  width: `${Math.round(
                    (state.batchState.done / Math.max(state.batchState.total, 1)) * 100
                  )}%`,
                }}
              />
            </div>
            <div className="batch-progress-detail">
              <span className="batch-progress-text">
                バッチ {state.batchState.batch}/{state.batchState.totalBatches} を処理中
              </span>
              <span className="batch-progress-sub">
                字幕 {state.batchState.done}/{state.batchState.total} 件完了
              </span>
            </div>
            <button className="cue-retry-btn" onClick={handleCancelBatch}>
              中止
            </button>
          </div>
        )}

        {/* Save section */}
        <div className="review-save-section">
          <p className="save-info-text">
            採用されたAI翻訳だけを反映し、元のSRTは変更せずに新しいSRTファイルを作成します。
          </p>
          <div className="review-save-row">
            <button
              className="repair-button"
              disabled={acceptedCues.length === 0}
              onClick={handleSave}
            >
              選択した字幕を新しいSRTに保存
            </button>
            <button className="link-btn" onClick={handleChangeFolder}>
              保存先フォルダを変更
            </button>
          </div>
        </div>

        {/* Post-save success */}
        {hasSaved && (
          <div className="batch-save-success">
            <div className="save-success-banner">
              AI修正済みSRTを作成しました。
            </div>
            <div className="output-path">
              <code className="output-value">{state.savedPath}</code>
            </div>
            <div className="save-actions">
              <button className="modal-btn save-btn" onClick={handleOpenFile}>
                ファイルを開く
              </button>
              <button className="modal-btn" onClick={handleOpenFolder}>
                フォルダを開く
              </button>
              <button className="modal-btn" onClick={handleCopyPath}>
                {state.copyFeedback ? "コピーしました" : "パスをコピー"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════ Zone 2: Table ═══════════════ */}
      <div className="review-table-wrapper">
        <table className="review-table">
          <thead>
            <tr>
              <th className="col-id">#</th>
              <th className="col-start">開始時間</th>
              <th className="col-end">終了時間</th>
              <th className="col-duration">表示時間</th>
              <th className="col-source">元英語</th>
              <th className="col-current">現在の訳</th>
              <th className="col-ai">AI候補</th>
              <th className="col-conf">確度</th>
              <th className="col-status">状態</th>
              <th className="col-note">備考</th>
              <th className="col-accept">採用</th>
              <th className="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredCues.map((c) => (
              <tr
                key={c.id}
                className={`${rowClass(c)}${state.selectedId === c.id ? " row-selected" : ""}`}
                onClick={() => dispatch({ type: "SELECT_CUE", id: c.id })}
              >
                <td className="col-id">{c.id}</td>
                <td className="col-start">{c.start}</td>
                <td className="col-end">{c.end}</td>
                <td className="col-duration">{c.duration}</td>
                <td className="col-source" title={c.sourceText}>
                  {truncate(c.sourceText, 40) || <em className="empty-text">（空）</em>}
                </td>
                <td className="col-current" title={c.currentTranslation}>
                  {c.currentTranslation || <em className="empty-text">（翻訳なし）</em>}
                </td>
                <td className="col-ai" title={c.aiTranslation}>
                  {c.aiTranslation || <em className="empty-text">（なし）</em>}
                </td>
                <td className="col-conf">
                  {c.confidence > 0 ? `${(c.confidence * 100).toFixed(0)}%` : "-"}
                </td>
                <td className="col-status">
                  <span className={`status-chip status-${c.status}`}>
                    {statusLabel(c.status)}
                  </span>
                </td>
                <td className="col-note" title={c.note}>
                  {truncate(c.note, 30)}
                </td>
                <td className="col-accept">
                  <button
                    className={`toggle-btn${c.status === "accepted" ? " toggle-on" : " toggle-off"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: "TOGGLE_ACCEPT", id: c.id });
                    }}
                  >
                    {c.status === "accepted" ? "採用" : "未"}
                  </button>
                </td>
                <td className="col-actions">
                  <div className="action-btns">
                    {c.isAiRepairable && c.status !== "accepted" && (
                      <button
                        className="cue-retry-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAiRepair(c);
                        }}
                        disabled={c.note === "AI翻訳中..."}
                      >
                        AIで修正
                      </button>
                    )}
                    {c.status !== "rejected" && (
                      <button
                        className="link-btn reject-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch({ type: "REJECT_CUE", id: c.id });
                        }}
                      >
                        却下
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCues.length === 0 && (
          <p className="table-empty">該当する字幕はありません。</p>
        )}
      </div>

      {/* ═══════════════ Zone 3: Detail Pane ═══════════════ */}
      {selectedCue && (
        <div className="review-detail-pane" ref={detailRef}>
          <h3>字幕 #{selectedCue.id} の詳細</h3>

          <div className="detail-grid">
            {/* Left: Before (read-only) */}
            <div className="detail-left">
              <h4>修正前</h4>
              <dl>
                <dt>字幕番号</dt>
                <dd>{selectedCue.id}</dd>
                <dt>時間</dt>
                <dd className="detail-time">{selectedCue.start} → {selectedCue.end}</dd>
                <dt>表示時間</dt>
                <dd>{selectedCue.duration}</dd>
              </dl>
              <div className="detail-field">
                <label>元の英語字幕</label>
                <p className="detail-text">{selectedCue.sourceText || <em className="empty-text">（空）</em>}</p>
              </div>
              <div className="detail-field">
                <label>現在の日本語訳</label>
                <p className="detail-text">
                  {selectedCue.currentTranslation || <em className="empty-text">（翻訳なし）</em>}
                </p>
              </div>
            </div>

            {/* Right: After / AI candidate */}
            <div className="detail-right">
              <h4>修正後 / AI候補</h4>
              <div className="detail-field">
                <label>AI翻訳候補</label>
                <p className="detail-text">
                  {selectedCue.aiTranslation || <em className="empty-text">（なし）</em>}
                </p>
              </div>
              {selectedCue.confidence > 0 && (
                <div className="detail-field">
                  <label>確度</label>
                  <p className="detail-text">{(selectedCue.confidence * 100).toFixed(0)}%</p>
                </div>
              )}
              <div className="detail-field">
                <label>編集（編集内容が保存に使われます）</label>
                <textarea
                  className="detail-textarea"
                  rows={3}
                  value={selectedCue.editedTranslation}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_EDITED_TRANSLATION",
                      id: selectedCue.id,
                      text: e.target.value,
                    })
                  }
                  placeholder={selectedCue.aiTranslation || "翻訳を入力してください..."}
                />
              </div>

              <div className="detail-actions">
                <button
                  className="modal-btn save-btn"
                  onClick={() => dispatch({ type: "TOGGLE_ACCEPT", id: selectedCue.id })}
                >
                  {selectedCue.status === "accepted" ? "採用を取り消し" : "採用"}
                </button>
                <button
                  className="modal-btn"
                  onClick={() => dispatch({ type: "REJECT_CUE", id: selectedCue.id })}
                >
                  却下
                </button>
                {selectedCue.isAiRepairable && (
                  <button
                    className="cue-retry-btn"
                    onClick={() => handleAiRepair(selectedCue)}
                  >
                    再AI修正
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Bottom: Status + Notes + Error */}
          <div className="detail-meta">
            <div className="detail-status">
              <span className="detail-label">状態: </span>
              <span className={`status-chip status-${selectedCue.status}`}>
                {statusLabel(selectedCue.status)}
              </span>
            </div>
            {selectedCue.note && (
              <div className="detail-note">
                <span className="detail-label">備考: </span>
                <span className={selectedCue.status === "error" ? "error-text" : ""}>
                  {selectedCue.note}
                </span>
              </div>
            )}
            {selectedCue.error && (
              <div className="detail-error">
                <span className="detail-label">エラー: </span>
                <span className="error-text">{selectedCue.error}</span>
              </div>
            )}
            {selectedCue.userEdited && (
              <div className="detail-edited">手動編集済み</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
