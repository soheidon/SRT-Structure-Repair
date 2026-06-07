import {
  useState,
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useEffect,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ReviewCue,
  ReviewCueStatus,
  RepairedCue,
  BatchRepairCue,
  BatchRepairResult,
  LlmConfig,
  AiMode,
  ReviewLogEntry,
} from "../types";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Truncate text for table cell display. */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Tooltip descriptions for AI operations and UI actions. */
const TOOLTIP = {
  supplement:
    "翻訳が空の字幕だけにAI候補を作ります。既存訳は変更しません。",
  retranslate:
    "既存訳も含めてAIで訳し直します。結果は候補として表示され、すぐには保存されません。",
  review:
    "訳の対応ずれや不自然さをAIに点検させ、必要なら候補を出します。",
  retry:
    "前回エラーになった字幕だけを、同じ条件で再度AI処理します。",
  emptyCheck:
    "元英語が空の字幕を確認します。日本語だけある場合は対応ずれの可能性があります。",
  acceptAllCandidates:
    "AI翻訳候補がある字幕をすべて採用済みにします。保存するまではSRTには反映されません。",
  selectAll:
    "現在表示中のタブにある字幕をすべて選択します。",
  deselectAll:
    "現在表示中の字幕の選択をすべて解除します。",
  save:
    "採用されたAI翻訳だけを反映し、元のSRTは変更せずに新しいSRTファイルを作成します。",
  accept:
    "選択した字幕を採用済みにします。保存時に新しいSRTに反映されます。",
  reject:
    "選択した字幕のAI候補を使わず、元の翻訳を維持します。",
} as const;

/** Create a review log entry with timestamp. */
function makeLogEntry(
  action: string,
  message: string,
  cueIds?: number[],
  count?: number,
): ReviewLogEntry {
  return {
    timestamp: new Date().toISOString(),
    action,
    message,
    cueIds,
    count: count ?? (cueIds?.length ?? 0),
  };
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
  lastClickedCueId: number | null;
  batchState: BatchState;
  savedPath: string | null;
  batchSize: number;
  copyFeedback: boolean;
  saving: boolean;
  reviewLog: ReviewLogEntry[];
  logSavedPath: string | null;
}

type PanelAction =
  | { type: "SELECT_CUE"; id: number | null }
  | { type: "TOGGLE_SELECT_SINGLE"; id: number }
  | { type: "RANGE_SELECT"; fromId: number; toId: number }
  | { type: "SELECT_ALL_VISIBLE" }
  | { type: "ACCEPT_SELECTED" }
  | { type: "REJECT_SELECTED" }
  | { type: "TOGGLE_ACCEPT"; id: number }
  | { type: "REJECT_CUE"; id: number }
  | { type: "SET_FILTER"; filter: FilterTab }
  | { type: "SET_AI_RESULT"; id: number; translation: string; confidence: number }
  | { type: "SET_AI_ERROR"; id: number; error: string }
  | { type: "SET_AI_LOADING"; id: number }
  | { type: "MERGE_BATCH_RESULTS"; results: BatchRepairResult[] }
  | { type: "MERGE_REVIEW_RESULTS"; results: BatchRepairResult[] }
  | { type: "SET_EDITED_TRANSLATION"; id: number; text: string }
  | { type: "TOGGLE_SELECT_ALL" }
  | { type: "ACCEPT_ALL_CANDIDATES" }
  | { type: "DESELECT_ALL" }
  | { type: "SET_SAVED_PATH"; path: string }
  | { type: "SET_BATCH_STATE"; state: BatchState }
  | { type: "SET_BATCH_SIZE"; size: number }
  | { type: "SET_COPY_FEEDBACK"; feedback: boolean }
  | { type: "NAVIGATE"; direction: "up" | "down" }
  | { type: "APPEND_LOG"; entry: ReviewLogEntry }
  | { type: "SET_SAVING"; saving: boolean }
  | { type: "SET_LOG_SAVED_PATH"; path: string }
  | { type: "CLEAR_LOG_SAVED" };

const emptyBatchState: BatchState = { phase: "idle" };

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "SELECT_CUE":
      return { ...state, selectedId: action.id, lastClickedCueId: action.id };

    case "TOGGLE_SELECT_SINGLE": {
      const cues = state.cues.map((c) =>
        c.id === action.id ? { ...c, selected: !c.selected } : c
      );
      return { ...state, cues, lastClickedCueId: action.id };
    }

    case "RANGE_SELECT": {
      const filtered = getFilteredCues(state.cues, state.filter);
      const idxFrom = filtered.findIndex((c) => c.id === action.fromId);
      const idxTo = filtered.findIndex((c) => c.id === action.toId);
      if (idxFrom === -1 || idxTo === -1) return state;
      const [lo, hi] = [Math.min(idxFrom, idxTo), Math.max(idxFrom, idxTo)];
      const rangeIds = new Set(filtered.slice(lo, hi + 1).map((c) => c.id));
      const cues = state.cues.map((c) =>
        rangeIds.has(c.id) ? { ...c, selected: true } : c
      );
      return { ...state, cues };
    }

    case "SELECT_ALL_VISIBLE": {
      const filteredIds = new Set(getFilteredCues(state.cues, state.filter).map((c) => c.id));
      const cues = state.cues.map((c) =>
        filteredIds.has(c.id) ? { ...c, selected: true } : c
      );
      return { ...state, cues };
    }

    case "ACCEPT_SELECTED": {
      const cues = state.cues.map((c) =>
        c.selected
          ? { ...c, status: "accepted" as ReviewCueStatus, note: c.note || "一括採用" }
          : c
      );
      return { ...state, cues };
    }

    case "REJECT_SELECTED": {
      const cues = state.cues.map((c) =>
        c.selected
          ? { ...c, status: "rejected" as ReviewCueStatus, selected: false, note: "候補を使わない" }
          : c
      );
      return { ...state, cues };
    }

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
      const isAccepted = state.cues.find((c) => c.id === action.id)?.status !== "accepted";
      const logEntry = makeLogEntry(
        isAccepted ? "accept_cue" : "unaccept_cue",
        isAccepted ? `AI候補を採用: #${action.id}` : `採用を取り消し: #${action.id}`,
        [action.id],
        1,
      );
      return { ...state, cues, reviewLog: [...state.reviewLog, logEntry] };
    }

    case "REJECT_CUE": {
      const cues = state.cues.map((c) => {
        if (c.id !== action.id) return c;
        return { ...c, status: "rejected" as ReviewCueStatus, selected: false, note: "候補を使わない" };
      });
      const logEntry = makeLogEntry(
        "reject_cue",
        `候補を使わないにした: #${action.id}`,
        [action.id],
        1,
      );
      return { ...state, cues, reviewLog: [...state.reviewLog, logEntry] };
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

    case "MERGE_REVIEW_RESULTS": {
      const resultMap = new Map(action.results.map((r) => [r.id, r]));
      const cues = state.cues.map((c) => {
        const r = resultMap.get(c.id);
        if (!r) return c;
        if (r.error && !r.llm_translation && !r.review_comment) {
          return {
            ...c,
            status: "error" as ReviewCueStatus,
            error: r.error || "",
            note: `AI review failed: ${r.error || ""}`,
          };
        }
        const reviewNote = r.review_comment
          ? `AI再検討: ${r.review_comment}`
          : "AI再検討済";
        return {
          ...c,
          aiTranslation: r.llm_translation || c.aiTranslation,
          confidence: r.confidence,
          status: "ai_reviewed" as ReviewCueStatus,
          error: "",
          note: reviewNote,
          reviewComment: r.review_comment || "",
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
      const logEntry = makeLogEntry(
        "edit_translation",
        `翻訳候補を手動編集: #${action.id}`,
        [action.id],
        1,
      );
      return { ...state, cues, reviewLog: [...state.reviewLog, logEntry] };
    }

    case "TOGGLE_SELECT_ALL": {
      const filteredIds = new Set(getFilteredCues(state.cues, state.filter).map((c) => c.id));
      const allFilteredSelected = state.cues
        .filter((c) => filteredIds.has(c.id))
        .every((c) => c.selected);
      const cues = state.cues.map((c) =>
        filteredIds.has(c.id) ? { ...c, selected: !allFilteredSelected } : c
      );
      return { ...state, cues };
    }

    case "DESELECT_ALL": {
      const filteredIds = new Set(getFilteredCues(state.cues, state.filter).map((c) => c.id));
      const cues = state.cues.map((c) =>
        filteredIds.has(c.id) ? { ...c, selected: false } : c
      );
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

    case "APPEND_LOG":
      return { ...state, reviewLog: [...state.reviewLog, action.entry] };

    case "SET_SAVING":
      return { ...state, saving: action.saving };

    case "SET_LOG_SAVED_PATH":
      return { ...state, logSavedPath: action.path };

    case "CLEAR_LOG_SAVED":
      return { ...state, logSavedPath: null };

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
        ["candidate", "ai_individual_repaired", "ai_batch_repaired", "candidate_edited", "ai_reviewed", "ai_retranslated"].includes(c.status)
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
      return cues.filter((c) => ["empty", "source_empty_target_exists"].includes(c.status));
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
  workDir: string;
  onSave: (accepted: BatchRepairResult[], outputDir?: string) => Promise<string>;
  onConnectionSuccess: () => void;
  onOpenSettings: (tab: "ai" | "workdir") => void;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ReviewPanel({
  initialCues,
  repairedCues,
  llmConfig,
  llmConfigured: _llmConfigured,
  aiConnectionOk,
  translatedFileName,
  workDir,
  onSave,
  onConnectionSuccess,
  onOpenSettings,
}: ReviewPanelProps) {
  const [state, dispatch] = useReducer(panelReducer, {
    cues: initialCues,
    filter: "all",
    selectedId: null,
    batchState: emptyBatchState,
    savedPath: null,
    lastClickedCueId: null,
    batchSize: 15,
    copyFeedback: false,
    saving: false,
    reviewLog: [],
    logSavedPath: null,
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

  // UI toggle state (expandable sections)
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  const cancelledRef = useRef(false);
  const detailRef = useRef<HTMLDivElement>(null);

  // ── Derived output dir from workspace folder ──────────────────────────────
  const outputDir = workDir ? `${workDir}\\outputs` : null;

  // ── Derived values ─────────────────────────────────────────────────────
  const filteredCues = useMemo(
    () => getFilteredCues(state.cues, state.filter),
    [state.cues, state.filter]
  );

  const selectedCue = useMemo(
    () => state.cues.find((c) => c.id === state.selectedId) ?? null,
    [state.cues, state.selectedId]
  );

  const selectedCount = useMemo(
    () => state.cues.filter((c) => c.selected).length,
    [state.cues]
  );

  const filteredSelectedCount = useMemo(
    () => filteredCues.filter((c) => c.selected).length,
    [filteredCues]
  );

  const counts = useMemo(() => {
    const c = state.cues;
    return {
      total: c.length,
      aiEligible: c.filter((x) => x.isAiRepairable).length,
      fullRetransTarget: c.filter((x) => !!x.sourceText).length,
      emptySource: c.filter((x) => x.status === "empty").length,
      other: c.filter(
        (x) => !x.isAiRepairable && x.status !== "empty" && x.status !== "accepted" && x.status !== "rejected"
      ).length,
      candidate: c.filter((x) =>
        ["candidate", "ai_individual_repaired", "ai_batch_repaired", "candidate_edited", "ai_reviewed", "ai_retranslated"].includes(x.status)
      ).length,
      accepted: c.filter((x) => x.status === "accepted").length,
      rejected: c.filter((x) => x.status === "rejected").length,
      unreviewed: c.filter((x) =>
        ["unreviewed", "needs_review"].includes(x.status)
      ).length,
      sourceEmptyTargetExists: c.filter((x) => x.status === "source_empty_target_exists").length,
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
    { key: "rejected", label: "候補を使わない", count: counts.rejected },
    { key: "error", label: "エラー", count: state.cues.filter((c) => c.status === "error").length },
    { key: "empty", label: "空字幕", count: counts.emptySource },
  ];

  const selectAllLabel = "すべて選択";

  // Log panel opened on mount
  useEffect(() => {
    dispatch({ type: "APPEND_LOG", entry: makeLogEntry("panel_opened", "レビュー画面を開いた") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Log filter changes (skip initial render)
  const prevFilterRef = useRef(state.filter);
  useEffect(() => {
    if (prevFilterRef.current !== state.filter) {
      const label = filterTabs.find((t) => t.key === state.filter)?.label ?? state.filter;
      dispatch({ type: "APPEND_LOG", entry: makeLogEntry("filter_changed", `フィルタータブを切り替え: ${label}`) });
      prevFilterRef.current = state.filter;
    }
  }, [state.filter, filterTabs]);

  // ── Status display ─────────────────────────────────────────────────────
  const statusLabel = (s: ReviewCueStatus): string => {
    switch (s) {
      case "unreviewed": return "未確認";
      case "needs_review": return "確認が必要";
      case "candidate": return "AI候補あり";
      case "ai_individual_repaired": return "AI個別修正済";
      case "ai_batch_repaired": return "一括AI修正済";
      case "ai_reviewed": return "AI再検討済";
      case "ai_retranslated": return "AI再翻訳済";
      case "candidate_edited": return "編集済候補";
      case "accepted": return "採用済み";
      case "rejected": return "候補を使わない";
      case "empty": return "空字幕";
      case "source_empty_target_exists": return "日本語のみ";
      case "error": return "エラー";
    }
  };

  // ── Row class ──────────────────────────────────────────────────────────
  const rowClass = (c: ReviewCue): string => {
    const classes: string[] = [];
    // Status-based coloring
    if (c.status === "accepted") classes.push("row-accepted");
    else if (c.status === "rejected" || c.status === "empty") classes.push("row-rejected");
    else if (c.status === "error") classes.push("row-error");
    else if (c.status === "source_empty_target_exists") classes.push("row-error");
    else if (["candidate", "ai_individual_repaired", "ai_batch_repaired", "candidate_edited", "ai_reviewed", "ai_retranslated"].includes(c.status))
      classes.push("row-candidate");
    // Focus (detail pane)
    if (state.selectedId === c.id) classes.push("row-focused");
    // Bulk selection
    if (c.selected) classes.push("row-selected-for-bulk");
    return classes.join(" ");
  };

  // ── Tab-aware operation targets ─────────────────────────────────────────
  const tabOps = useMemo(() => {
    const filtered = getFilteredCues(state.cues, state.filter);
    const withSource = filtered.filter((c) => !!c.sourceText);
    const needsSupplement = withSource.filter((c) => !c.currentTranslation);
    const sourceEmptyTargetExists = filtered.filter(
      (c) => c.status === "source_empty_target_exists"
    );

    const allWithSource = state.cues.filter((c) => !!c.sourceText);
    const allNeedsSupplement = allWithSource.filter((c) => !c.currentTranslation);

    return {
      supplementTargets: needsSupplement,
      retranslateTargets: withSource,
      reviewTargets: filtered,
      sourceEmptyTargetExists,
      // For cross-tab context
      allWithSource,
      allNeedsSupplement,
    };
  }, [state.cues, state.filter]);

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
            dispatch({
              type: "APPEND_LOG",
              entry: makeLogEntry("ai_individual_repair", `個別AI修正: #${cue.id}`, [cue.id], 1),
            });
            onConnectionSuccess();
          } else {
            dispatch({
              type: "SET_AI_ERROR",
              id: cue.id,
              error: r.error || "No translation returned",
            });
            dispatch({
              type: "APPEND_LOG",
              entry: makeLogEntry("ai_error", `エラー: #${cue.id} - ${r.error || "No translation returned"}`, [cue.id], 1),
            });
          }
        }
      } catch (e) {
        dispatch({ type: "SET_AI_ERROR", id: cue.id, error: String(e) });
      }
    },
    [repairedCues, onConnectionSuccess]
  );

  // ── AI batch operations ─────────────────────────────────────────────────
  /** Generic batch translate/review loop. */
  const runBatchLoop = useCallback(
    async (targets: ReviewCue[], mode: AiMode) => {
      if (targets.length === 0) return;

      const totalBatches = Math.ceil(targets.length / state.batchSize);
      dispatch({
        type: "SET_BATCH_STATE",
        state: { phase: "repairing", batch: 0, totalBatches, done: 0, total: targets.length },
      });
      cancelledRef.current = false;

      let cumulativeDone = 0;
      for (let i = 0; i < totalBatches; i++) {
        if (cancelledRef.current) {
          const remaining = targets.slice(i * state.batchSize);
          const cancelledResults: BatchRepairResult[] = remaining.map((c) => ({
            id: c.id, source_text: c.sourceText, original_translation: c.currentTranslation,
            llm_translation: "", confidence: 0, status: "Pending" as const,
            error: "キャンセルされました",
          }));
          dispatch({ type: mode === "review" ? "MERGE_REVIEW_RESULTS" : "MERGE_BATCH_RESULTS", results: cancelledResults });
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
            { cues: batchCues, batchSize: state.batchSize, mode }
          );
          if (mode === "review") {
            dispatch({ type: "MERGE_REVIEW_RESULTS", results });
          } else {
            dispatch({ type: "MERGE_BATCH_RESULTS", results });
          }
          cumulativeDone += chunk.length;
          onConnectionSuccess();
        } catch (e) {
          const errorResults: BatchRepairResult[] = chunk.map((c) => ({
            id: c.id, source_text: c.sourceText, original_translation: c.currentTranslation,
            llm_translation: "", confidence: 0, status: "Pending" as const,
            error: `バッチ ${i + 1} 失敗: ${String(e)}`,
          }));
          dispatch({ type: mode === "review" ? "MERGE_REVIEW_RESULTS" : "MERGE_BATCH_RESULTS", results: errorResults });
          cumulativeDone += chunk.length;
        }
      }

      dispatch({ type: "SET_BATCH_STATE", state: { phase: "done" } });
    },
    [state.batchSize, repairedCues, onConnectionSuccess]
  );

  const handleAiOperation = useCallback(
    async (targets: ReviewCue[], mode: AiMode, confirmMsg?: string) => {
      if (targets.length === 0) return;
      if (!llmConfig?.configured) return;
      if (confirmMsg && !window.confirm(confirmMsg)) return;
      // Auto-test connection if not yet confirmed
      if (!aiConnectionOk) {
        try {
          await invoke<string>("test_llm_connection");
          onConnectionSuccess();
        } catch (_e) {
          // Connection test failed — proceed anyway, backend will handle errors
        }
      }
      await runBatchLoop(targets, mode);
      const modeLabels: Record<AiMode, string> = {
        supplement_untranslated: "AI補完",
        review: "AI再検討",
        retranslate: "AI再翻訳",
      };
      dispatch({
        type: "APPEND_LOG",
        entry: makeLogEntry(
          mode === "supplement_untranslated" ? "ai_supplement" : mode === "review" ? "ai_review" : "ai_retranslate",
          `${modeLabels[mode]}を実行: ${targets.length}件`,
          targets.map((c) => c.id),
          targets.length,
        ),
      });
    },
    [runBatchLoop, llmConfig, aiConnectionOk, onConnectionSuccess]
  );

  const handleCancelBatch = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  // ── Save ───────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (acceptedCues.length === 0) return;
    dispatch({ type: "SET_SAVING", saving: true });
    // Clear previous save state so UI resets pre-save for re-save
    if (state.savedPath) dispatch({ type: "SET_SAVED_PATH", path: "" } as PanelAction);
    const batchResult: BatchRepairResult[] = acceptedCues.map((c) => ({
      id: c.id,
      source_text: c.sourceText,
      original_translation: c.currentTranslation,
      llm_translation: c.editedTranslation || c.aiTranslation || c.currentTranslation,
      confidence: c.confidence,
      status: "Accepted" as const,
    }));

    try {
      const path = await onSave(batchResult, outputDir ?? undefined);
      dispatch({ type: "SET_SAVED_PATH", path });
      dispatch({
        type: "APPEND_LOG",
        entry: makeLogEntry(
          "save_srt",
          `新しいSRTとして保存: ${path}`,
          acceptedCues.map((c) => c.id),
          acceptedCues.length,
        ),
      });
    } catch (e) {
      // Error handled by parent
    }
    dispatch({ type: "SET_SAVING", saving: false });
  }, [acceptedCues, outputDir, onSave, state.savedPath]);

  // ── Post-save actions ──────────────────────────────────────────────────
  const handleOpenFile = useCallback(async () => {
    if (state.savedPath) {
      await invoke("open_file", { path: state.savedPath });
      dispatch({ type: "APPEND_LOG", entry: makeLogEntry("open_file", `ファイルを開いた: ${state.savedPath}`) });
    }
  }, [state.savedPath]);

  const handleOpenFolder = useCallback(async () => {
    if (state.savedPath) {
      await invoke("open_folder", { path: state.savedPath });
      dispatch({ type: "APPEND_LOG", entry: makeLogEntry("open_folder", `フォルダを開いた: ${state.savedPath}`) });
    }
  }, [state.savedPath]);

  const handleCopyPath = useCallback(async () => {
    if (state.savedPath) {
      await invoke("copy_to_clipboard", { text: state.savedPath });
      dispatch({ type: "SET_COPY_FEEDBACK", feedback: true });
      setTimeout(() => dispatch({ type: "SET_COPY_FEEDBACK", feedback: false }), 2000);
      dispatch({ type: "APPEND_LOG", entry: makeLogEntry("copy_path", `パスをコピー: ${state.savedPath}`) });
    }
  }, [state.savedPath]);

  // ── Predicted save path ────────────────────────────────────────────────
  const [predictedPath, setPredictedPath] = useState<string | null>(null);
  useEffect(() => {
    if (translatedFileName) {
      invoke<string>("predict_llm_output_path", {
        translatedFileName,
        outputDir: outputDir ?? null,
      }).then(setPredictedPath);
    }
  }, [translatedFileName, outputDir]);

  // ── Folder picker (delegates to workspace settings) ─────────────────────
  const handleChangeFolder = useCallback(() => {
    onOpenSettings("workdir");
  }, [onOpenSettings]);

  // ── Review log save handlers ────────────────────────────────────────────
  const handleSaveLog = useCallback(async () => {
    try {
      const path = await invoke<string>("save_review_log", {
        logEntries: state.reviewLog,
        translatedFileName: translatedFileName ?? "review",
        workDir: workDir ?? null,
      });
      dispatch({ type: "SET_LOG_SAVED_PATH", path });
      dispatch({
        type: "APPEND_LOG",
        entry: makeLogEntry("save_log", `作業ログを保存: ${path}`),
      });
    } catch (e) {
      console.error("Failed to save review log:", e);
    }
  }, [state.reviewLog, translatedFileName, workDir]);

  const handleOpenLog = useCallback(async () => {
    if (state.logSavedPath) {
      await invoke("open_file", { path: state.logSavedPath });
      dispatch({ type: "APPEND_LOG", entry: makeLogEntry("open_log", `ログを開いた: ${state.logSavedPath}`) });
    }
  }, [state.logSavedPath]);

  const handleOpenLogFolder = useCallback(async () => {
    if (state.logSavedPath) {
      await invoke("open_folder", { path: state.logSavedPath });
      dispatch({ type: "APPEND_LOG", entry: makeLogEntry("open_log_folder", `ログフォルダを開いた: ${state.logSavedPath}`) });
    }
  }, [state.logSavedPath]);

  const handleCopyLogPath = useCallback(async () => {
    if (state.logSavedPath) {
      await invoke("copy_to_clipboard", { text: state.logSavedPath });
      dispatch({ type: "APPEND_LOG", entry: makeLogEntry("copy_log_path", `ログパスをコピー: ${state.logSavedPath}`) });
    }
  }, [state.logSavedPath]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Block when focus is in input/textarea (but allow checkboxes)
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement &&
        target.type !== "checkbox"
      ) return;
      if (target instanceof HTMLTextAreaElement) return;

      // Ctrl+S: Save
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      // Ctrl+R: AI repair on focused cue
      if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        if (selectedCue?.isAiRepairable) handleAiRepair(selectedCue);
        return;
      }
      // Ctrl/Cmd+A: Select all visible
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        dispatch({ type: "SELECT_ALL_VISIBLE" });
        return;
      }
      // Escape: Deselect all
      if (e.key === "Escape") {
        e.preventDefault();
        dispatch({ type: "DESELECT_ALL" });
        return;
      }
      // Space: Toggle selection of focused row
      if (e.key === " " && selectedCue) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_SELECT_SINGLE", id: selectedCue.id });
        return;
      }
      // ArrowUp / Shift+ArrowUp
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (e.shiftKey && selectedCue) {
          const filtered = getFilteredCues(state.cues, state.filter);
          const curIdx = filtered.findIndex((c) => c.id === state.selectedId);
          if (curIdx > 0) {
            const prevCue = filtered[curIdx - 1];
            dispatch({ type: "RANGE_SELECT", fromId: state.lastClickedCueId ?? prevCue.id, toId: prevCue.id });
          }
        }
        dispatch({ type: "NAVIGATE", direction: "up" });
        return;
      }
      // ArrowDown / Shift+ArrowDown
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (e.shiftKey && selectedCue) {
          const filtered = getFilteredCues(state.cues, state.filter);
          const curIdx = filtered.findIndex((c) => c.id === state.selectedId);
          if (curIdx < filtered.length - 1) {
            const nextCue = filtered[curIdx + 1];
            dispatch({ type: "RANGE_SELECT", fromId: state.lastClickedCueId ?? nextCue.id, toId: nextCue.id });
          }
        }
        dispatch({ type: "NAVIGATE", direction: "down" });
        return;
      }
      // Enter: Toggle accept on focused cue
      if (e.key === "Enter" && selectedCue) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_ACCEPT", id: selectedCue.id });
        return;
      }
      // Delete: Reject focused cue
      if (e.key === "Delete" && selectedCue) {
        e.preventDefault();
        dispatch({ type: "REJECT_CUE", id: selectedCue.id });
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedCue, state.cues, state.filter, state.selectedId, state.lastClickedCueId, handleSave, handleAiRepair]);

  // Scroll detail pane into view when a cue is selected
  useEffect(() => {
    if (state.selectedId && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [state.selectedId]);

  // ── Render ─────────────────────────────────────────────────────────────
  const hasSaved = state.savedPath !== null;

  return (
    <section className="review-panel">
      <h2>字幕レビュー</h2>

      {/* ═══════════════ Zone 1: Top Bar (3 cards) ═══════ */}
      <div className="review-topbar">

        {/* ── Card 1: AIによる検討・翻訳 (merged) ─────── */}
        <div className="review-card review-card--wide">
          <h3 className="review-card-title">AIによる検討・翻訳</h3>

          {/* AI connection status */}
          {llmConfig && (
            <div className="ai-connection-status">
              <span className={`ai-status-dot${aiConnectionOk ? " configured" : ""}`} />
              <span className="ai-status-text">
                {llmConfig.provider !== "custom"
                  ? `${llmConfig.provider} · ${llmConfig.model}`
                  : `カスタム · ${llmConfig.model || "（モデル未設定）"}`}
                {aiConnectionOk ? " 接続済み" : " （未確認）"}
              </span>
            </div>
          )}

          {/* Count chips */}
          <div className="review-counts">
            <span className="count-chip">全字幕: {counts.total}件</span>
            <span className="count-chip count-ai">AI補完対象: {tabOps.allNeedsSupplement.length}件</span>
            <span className="count-chip count-retrans">AI再翻訳対象: {tabOps.allWithSource.length}件</span>
            {counts.emptySource > 0 && (
              <span className="count-chip count-empty">空字幕: {counts.emptySource}件</span>
            )}
            {counts.sourceEmptyTargetExists > 0 && (
              <span className="count-chip count-other">日本語のみ: {counts.sourceEmptyTargetExists}件</span>
            )}
            {counts.accepted > 0 && (
              <span className="count-chip count-accepted">採用済み: {counts.accepted}件</span>
            )}
            {counts.unreviewed > 0 && (
              <span className="count-chip count-unreviewed">未確認: {counts.unreviewed}件</span>
            )}
            {counts.candidate > 0 && (
              <span className="count-chip count-candidate">AI候補あり: {counts.candidate}件</span>
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

          {/* Help text */}
          <p className="ai-help-text">
            字幕を選択してから、補完・再検討・再翻訳を実行してください。
            AIの結果はすぐにはSRTに保存されず、候補として表示されます。
            採用した字幕だけを新しいSRTに保存します。
          </p>

          {/* ── AI詳細設定 (batch size, collapsed by default) ── */}
          <details
            className="advanced-section"
            open={showAdvancedSettings}
            onToggle={(e) => setShowAdvancedSettings((e.target as HTMLDetailsElement).open)}
          >
            <summary className="advanced-summary">AI詳細設定</summary>
            <label className="batch-size-label advanced-setting-row">
              バッチサイズ:
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
            </label>
          </details>

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

          {/* ── Bulk select actions ────────────────── */}
          <div className="review-bulk-actions">
            <span className="selection-count">
              選択中: <strong>{selectedCount}</strong>件
            </span>
            <span className="selection-tab-context">
              {filterTabs.find((t) => t.key === state.filter)?.label ?? ""}タブ: {filteredCues.length}件表示中
              {filteredSelectedCount > 0 && ` / ${filteredSelectedCount}件選択中`}
            </span>
            <button
              className="link-btn"
              onClick={() => dispatch({ type: "TOGGLE_SELECT_ALL" })}
              title={TOOLTIP.selectAll}
            >
              {selectAllLabel}
            </button>
            <button
              className="link-btn"
              onClick={() => dispatch({ type: "DESELECT_ALL" })}
              title={TOOLTIP.deselectAll}
            >
              選択をすべて解除
            </button>
            {counts.candidate > 0 && (
              <button
                className="link-btn"
                onClick={() => dispatch({ type: "ACCEPT_ALL_CANDIDATES" })}
                title={TOOLTIP.acceptAllCandidates}
              >
                AI候補ありをすべて採用
              </button>
            )}
          </div>

          {/* ── Selected-cue batch operations ────── */}
          <div className="review-selected-actions">
            <span className="selection-count">選択中の{selectedCount}件: </span>
            <button
              className="modal-btn save-btn"
              disabled={selectedCount === 0}
              onClick={() => {
                const sel = state.cues.filter((c) => c.selected);
                dispatch({ type: "ACCEPT_SELECTED" });
                dispatch({
                  type: "APPEND_LOG",
                  entry: makeLogEntry("accept_cues", `${sel.length}件のAI候補を採用`, sel.map((c) => c.id), sel.length),
                });
              }}
              title={TOOLTIP.accept}
            >
              採用
            </button>
            <button
              className="modal-btn"
              disabled={selectedCount === 0}
              onClick={() => {
                const sel = state.cues.filter((c) => c.selected);
                dispatch({ type: "REJECT_SELECTED" });
                dispatch({
                  type: "APPEND_LOG",
                  entry: makeLogEntry("reject_cues", `${sel.length}件を候補を使わないにした`, sel.map((c) => c.id), sel.length),
                });
              }}
              title={TOOLTIP.reject}
            >
              候補を使わない
            </button>
            <button
              className="ai-review-btn"
              disabled={!llmConfig?.configured || selectedCount === 0}
              onClick={() => {
                const targets = state.cues.filter((c) => c.selected);
                handleAiOperation(
                  targets,
                  "supplement_untranslated",
                  `選択中の${targets.length}件のうち、翻訳が空の字幕をAIで補完します。\n続行しますか？`
                );
              }}
              title={TOOLTIP.supplement}
            >
              補完
            </button>
            <button
              className="ai-review-btn"
              disabled={!llmConfig?.configured || selectedCount === 0}
              onClick={() => {
                const targets = state.cues.filter((c) => c.selected);
                handleAiOperation(
                  targets,
                  "review",
                  `選択中の${targets.length}件を再検討します。\n続行しますか？`
                );
              }}
              title={TOOLTIP.review}
            >
              再検討
            </button>
            <button
              className="ai-retrans-btn"
              disabled={!llmConfig?.configured || selectedCount === 0}
              onClick={() => {
                const targets = state.cues.filter((c) => c.selected);
                handleAiOperation(
                  targets,
                  "retranslate",
                  `選択中の${targets.length}件を再翻訳します。\n続行しますか？`
                );
              }}
              title={TOOLTIP.retranslate}
            >
              再翻訳
            </button>
          </div>
        </div>

        {/* ── Card 3: 保存 ───────────────────────────── */}
        <div className="review-card">
          <h3 className="review-card-title">保存</h3>
          <p className="save-info-text">
            採用済み: {acceptedCues.length}件
          </p>
          <p className="save-info-text">
            採用されたAI翻訳だけを反映し、元のSRTは変更せずに新しいSRTファイルを作成します。
          </p>

          {/* Pre-save: predicted path */}
          {predictedPath && !hasSaved && (
            <p className="save-dest-path">
              保存先: <code>{predictedPath}</code>
            </p>
          )}

          {/* Save buttons */}
          <div className="review-card-actions">
            <button
              className="save-btn"
              disabled={acceptedCues.length === 0 || state.saving}
              onClick={handleSave}
              title={TOOLTIP.save}
            >
              {state.saving ? "保存中..." : "新しいSRTとして保存"}
            </button>
            <button className="secondary-btn" onClick={handleChangeFolder}>
              保存先を変更
            </button>
          </div>

          {/* Post-save success */}
          {hasSaved && (
            <div className="save-success-block">
              <div className="save-success-banner">
                AI修正済みSRTを作成しました。
              </div>
              <div className="save-success-label">保存先:</div>
              <div className="saved-path-box">{state.savedPath}</div>
              <div className="saved-actions">
                <button className="modal-btn save-btn" onClick={handleOpenFile}>
                  ファイルを開く
                </button>
                <button className="secondary-btn" onClick={handleOpenFolder}>
                  フォルダを開く
                </button>
                <button className="secondary-btn" onClick={handleCopyPath}>
                  {state.copyFeedback ? "コピーしました" : "パスをコピー"}
                </button>
              </div>
            </div>
          )}

          {/* ── Review log section ── */}
          <details className="advanced-section">
            <summary className="advanced-summary">作業ログ</summary>
            <p className="log-note">
              作業ログには字幕本文やAI翻訳候補が含まれる場合があります。共有する場合は内容に注意してください。
            </p>
            <button
              className="secondary-btn"
              disabled={state.reviewLog.length === 0}
              onClick={handleSaveLog}
            >
              作業ログを保存
            </button>
            <span className="log-count-hint">
              {state.reviewLog.length > 0
                ? `（${state.reviewLog.length}件の操作を記録中）`
                : ""}
            </span>
            {state.logSavedPath && (
              <div className="save-success-block">
                <div className="save-success-banner">
                  作業ログを保存しました。
                </div>
                <div className="save-success-label">保存先:</div>
                <div className="saved-path-box">{state.logSavedPath}</div>
                <div className="saved-actions">
                  <button className="secondary-btn" onClick={handleOpenLog}>
                    ログを開く
                  </button>
                  <button className="secondary-btn" onClick={handleOpenLogFolder}>
                    ログフォルダを開く
                  </button>
                  <button className="secondary-btn" onClick={handleCopyLogPath}>
                    パスをコピー
                  </button>
                </div>
              </div>
            )}
          </details>
        </div>

      </div>

      {/* ═══════════════ Zone 2: Table ═══════════════ */}
      <div className="selection-help">
        <p>
          行クリックで詳細表示、Ctrl/Cmd+クリックで選択切替、Shift+クリックで範囲選択できます。
          チェックボックスでも個別選択が可能です。選択は一括操作の対象で、保存されるのは「採用済み」の字幕です。
        </p>
      </div>
      <div className="review-table-wrapper">
        <table className="review-table">
          <thead>
            <tr>
              <th className="col-select">
                <input
                  type="checkbox"
                  checked={filteredCues.length > 0 && filteredCues.every((c) => c.selected)}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        filteredCues.some((c) => c.selected) &&
                        !filteredCues.every((c) => c.selected);
                  }}
                  onChange={() => dispatch({ type: "TOGGLE_SELECT_ALL" })}
                  title="表示中の字幕をすべて選択/解除"
                />
              </th>
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
                className={rowClass(c)}
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    dispatch({ type: "TOGGLE_SELECT_SINGLE", id: c.id });
                    dispatch({ type: "SELECT_CUE", id: c.id });
                  } else if (e.shiftKey && state.lastClickedCueId != null) {
                    dispatch({ type: "RANGE_SELECT", fromId: state.lastClickedCueId, toId: c.id });
                    dispatch({ type: "SELECT_CUE", id: c.id });
                  } else {
                    dispatch({ type: "SELECT_CUE", id: c.id });
                  }
                }}
              >
                <td className="col-select" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={c.selected}
                    onChange={() => dispatch({ type: "TOGGLE_SELECT_SINGLE", id: c.id })}
                  />
                </td>
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
                        title={TOOLTIP.retry}
                      >
                        修正
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
                        候補を使わない
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
              {selectedCue.reviewComment && (
                <div className="detail-field">
                  <label>AI再検討コメント</label>
                  <p className="detail-text detail-review-comment">{selectedCue.reviewComment}</p>
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
                  候補を使わない
                </button>
                {selectedCue.isAiRepairable && (
                  <button
                    className="cue-retry-btn"
                    onClick={() => handleAiRepair(selectedCue)}
                    title={TOOLTIP.retry}
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
