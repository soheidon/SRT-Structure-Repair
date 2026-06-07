import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  RepairSummary,
  LlmConfig,
  BatchRepairResult,
  ReviewCue,
  ReviewCueStatus,
} from "./types";
import FileSelector from "./components/FileSelector";
import RepairControls from "./components/RepairControls";
import RepairSummaryView from "./components/RepairSummary";
import LlmSettings from "./components/LlmSettings";
import RepairLogWindow from "./components/RepairLogWindow";
import ReviewPanel from "./components/ReviewPanel";

/** Parse "HH:MM:SS,mmm" to ms */
function parseTimestamp(ts: string): number {
  const m = ts.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600000 +
    parseInt(m[2], 10) * 60000 +
    parseInt(m[3], 10) * 1000 +
    parseInt(m[4], 10)
  );
}

function formatDuration(start: string, end: string): string {
  const dt = parseTimestamp(end) - parseTimestamp(start);
  const mins = Math.floor(dt / 60000);
  const secs = Math.floor((dt % 60000) / 1000);
  const ms = dt % 1000;
  return mins > 0
    ? `${mins}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`
    : `${secs}.${String(ms).padStart(3, "0")}s`;
}

/** Map backend RepairStatus → ReviewCueStatus */
function mapInitialStatus(
  status: string,
  sourceText: string,
  notes?: string,
): ReviewCueStatus {
  if (!sourceText) return "empty";
  if (notes?.startsWith("AI repair failed") || notes?.startsWith("LLM repair failed"))
    return "error";
  if (status === "Unmatched") return "unreviewed";
  if (status === "NeedsReview") return "needs_review";
  return "needs_review";
}

export default function App() {
  // ── File state ───────────────────────────────────────────────────────
  const [originalFileName, setOriginalFileName] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [translatedFileName, setTranslatedFileName] = useState<string | null>(null);
  const [translatedContent, setTranslatedContent] = useState<string | null>(null);

  const [summary, setSummary] = useState<RepairSummary | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [showLlmSettings, setShowLlmSettings] = useState(false);
  const [showLogWindow, setShowLogWindow] = useState(false);

  // ── AI connection tracking (tied to provider/model) ──────────────────
  const lastProviderRef = useRef<string>("");
  const lastModelRef = useRef<string>("");
  const connectionOkRef = useRef(false);

  const aiConnectionOk =
    llmConfig != null &&
    connectionOkRef.current &&
    lastProviderRef.current === llmConfig.provider &&
    lastModelRef.current === llmConfig.model;

  // Reset connection state when provider/model change
  useEffect(() => {
    if (llmConfig) {
      if (
        lastProviderRef.current !== llmConfig.provider ||
        lastModelRef.current !== llmConfig.model
      ) {
        lastProviderRef.current = llmConfig.provider;
        lastModelRef.current = llmConfig.model;
        connectionOkRef.current = false;
      }
    }
  }, [llmConfig?.provider, llmConfig?.model]);

  const markAiSuccess = useCallback(() => {
    if (llmConfig) {
      lastProviderRef.current = llmConfig.provider;
      lastModelRef.current = llmConfig.model;
      connectionOkRef.current = true;
    }
  }, [llmConfig]);

  // ── Debug log ────────────────────────────────────────────────────────
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const addDebug = useCallback((msg: string) => {
    console.log("[D&D]", msg);
    setDebugLog((prev) => [...prev.slice(-19), msg]);
  }, []);
  const clearAllDebug = useCallback(() => setDebugLog([]), []);

  // ── LLM config ───────────────────────────────────────────────────────
  useEffect(() => {
    invoke<LlmConfig>("get_llm_config").then(setLlmConfig);
  }, []);

  const handleConfigChanged = useCallback((config: LlmConfig) => {
    setLlmConfig(config);
  }, []);

  const llmConfigured = llmConfig?.configured ?? false;

  const PROVIDER_NAMES: Record<string, string> = {
    openai: "OpenAI",
    deepseek: "DeepSeek",
    minimax: "MiniMax",
    kimi: "Kimi",
    custom: "Custom",
  };
  const providerName = llmConfig
    ? (PROVIDER_NAMES[llmConfig.provider] ?? llmConfig.provider)
    : "";

  // ── Derive ReviewCue[] from summary ──────────────────────────────────
  const reviewCues: ReviewCue[] = useMemo(() => {
    if (!summary) return [];
    return summary.needs_review_cues.map((cue) => {
      const hasSource = !!cue.source_text;
      const noTranslation = !cue.translated_text;
      const llmFailed =
        cue.notes?.startsWith("AI repair failed") ||
        cue.notes?.startsWith("LLM repair failed");

      return {
        id: cue.id,
        start: cue.start,
        end: cue.end,
        duration: formatDuration(cue.start, cue.end),
        sourceText: cue.source_text,
        currentTranslation: cue.translated_text,
        aiTranslation: "",
        editedTranslation: "",
        confidence: cue.confidence > 0 && cue.confidence < 1 ? cue.confidence : 0,
        status: mapInitialStatus(cue.status, cue.source_text, cue.notes),
        selected: false,
        userEdited: false,
        note: cue.notes ?? "",
        error: llmFailed ? (cue.notes ?? "") : "",
        isAiRepairable: hasSource && (noTranslation || llmFailed === true),
      };
    });
  }, [summary]);

  // ── Save ─────────────────────────────────────────────────────────────
  const handleBatchSave = useCallback(
    async (accepted: BatchRepairResult[], outputDir?: string): Promise<string> => {
      if (!summary) throw new Error("No repair summary available");
      return await invoke<string>("save_repaired_srt", {
        repairedCues: summary.repaired_cues,
        acceptedTranslations: accepted,
        translatedFileName: translatedFileName ?? "translated.srt",
        outputDir: outputDir ?? null,
      });
    },
    [summary, translatedFileName],
  );

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <div className="header-title">
            <h1>SRT字幕修復ツール</h1>
            <p className="subtitle">
              元の英語SRTを正本として、DeepL翻訳後の崩れたSRT字幕ファイルを修復します
            </p>
          </div>
          <button
            className="settings-toggle header-settings-btn"
            onClick={() => setShowLlmSettings(true)}
            title="AIの設定"
          >
            ⚙ AIの設定
          </button>
        </div>
      </header>

      <LlmSettings
        isOpen={showLlmSettings}
        onClose={() => setShowLlmSettings(false)}
        onConfigChanged={handleConfigChanged}
      />

      <main className="app-main">
        <section className="file-section">
          <FileSelector
            label="元の英語SRTファイル"
            fileName={originalFileName}
            disabled={isRepairing}
            onFileLoaded={(name, content) => {
              addDebug(`[original] loaded: ${name} (${content.length} chars)`);
              setOriginalFileName(name);
              setOriginalContent(content);
              setError(null);
            }}
            onClear={() => {
              addDebug("[original] cleared");
              setOriginalFileName(null);
              setOriginalContent(null);
            }}
          />
          <FileSelector
            label="翻訳後のSRTファイル（DeepL出力）"
            fileName={translatedFileName}
            disabled={isRepairing}
            onFileLoaded={(name, content) => {
              addDebug(`[translated] loaded: ${name} (${content.length} chars)`);
              setTranslatedFileName(name);
              setTranslatedContent(content);
              setError(null);
            }}
            onClear={() => {
              addDebug("[translated] cleared");
              setTranslatedFileName(null);
              setTranslatedContent(null);
            }}
          />
        </section>

        <RepairControls
          originalFileName={originalFileName}
          originalContent={originalContent}
          translatedFileName={translatedFileName}
          translatedContent={translatedContent}
          isRepairing={isRepairing}
          llmConfigured={llmConfigured}
          llmConfig={llmConfig}
          providerName={providerName}
          onOpenSettings={() => setShowLlmSettings(true)}
          onRepairStart={() => {
            setIsRepairing(true);
            setError(null);
            setSummary(null);
          }}
          onRepairComplete={(result) => {
            setSummary(result);
            setIsRepairing(false);
          }}
          onRepairError={(err) => {
            setError(err);
            setIsRepairing(false);
          }}
        />

        {/* Debug panel */}
        {!summary && debugLog.length > 0 && (
          <div className="debug-panel">
            <div className="debug-header">
              <span>D&D デバッグログ</span>
              <button className="debug-clear-btn" onClick={clearAllDebug}>
                クリア
              </button>
            </div>
            <div className="debug-log">
              {debugLog.map((line, i) => (
                <div key={i} className="debug-line">
                  {line}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="error-banner">
            <p>{error}</p>
          </div>
        )}

        {summary && (
          <>
            <RepairSummaryView
              summary={summary}
              onOpenLog={() => setShowLogWindow(true)}
            />
            {summary.needs_review > 0 && (
              <ReviewPanel
                initialCues={reviewCues}
                repairedCues={summary.repaired_cues}
                llmConfig={llmConfig}
                llmConfigured={llmConfigured}
                aiConnectionOk={aiConnectionOk}
                translatedFileName={translatedFileName}
                onSave={handleBatchSave}
                onConnectionSuccess={markAiSuccess}
              />
            )}
          </>
        )}
      </main>

      {summary && (
        <RepairLogWindow
          isOpen={showLogWindow}
          onClose={() => setShowLogWindow(false)}
          entries={summary.log_entries}
          processLog={summary.process_log}
        />
      )}
    </div>
  );
}
