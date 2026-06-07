import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RepairSummary, LlmConfig, BatchRepairCue, BatchRepairResult } from "./types";
import FileSelector from "./components/FileSelector";
import RepairControls from "./components/RepairControls";
import RepairSummaryView from "./components/RepairSummary";
import NeedsReviewList from "./components/NeedsReviewList";
import LlmSettings from "./components/LlmSettings";
import RepairLogWindow from "./components/RepairLogWindow";
import BatchRepairPanel from "./components/BatchRepairPanel";

export default function App() {
  // --- File state: name + content (no file paths needed) ---
  const [originalFileName, setOriginalFileName] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [translatedFileName, setTranslatedFileName] = useState<string | null>(
    null,
  );
  const [translatedContent, setTranslatedContent] = useState<string | null>(
    null,
  );

  const [summary, setSummary] = useState<RepairSummary | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmConfig, setLlmConfig] = useState<LlmConfig | null>(null);
  const [showLlmSettings, setShowLlmSettings] = useState(false);
  const [showLogWindow, setShowLogWindow] = useState(false);

  /// Ref for scrolling to batch repair panel
  const batchPanelRef = useRef<HTMLDivElement>(null);

  /// Debug messages for on-screen diagnostics
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const addDebug = useCallback((msg: string) => {
    console.log("[D&D]", msg);
    setDebugLog((prev) => [...prev.slice(-19), msg]);
  }, []);

  useEffect(() => {
    invoke<LlmConfig>("get_llm_config").then(setLlmConfig);
  }, []);

  const handleConfigChanged = useCallback((config: LlmConfig) => {
    setLlmConfig(config);
  }, []);

  /// Mark AI connection as successful
  const markAiSuccess = useCallback(() => {
    // Connection success is now shown by config state directly
  }, []);

  const clearAllDebug = useCallback(() => setDebugLog([]), []);

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

  // Build BatchRepairCue list from needs_review_cues (only translation-gap cues)
  const batchTargetCues: BatchRepairCue[] = useMemo(() => {
    if (!summary) return [];
    return summary.needs_review_cues
      .filter((cue) => {
        // Only include cues where: source exists AND (translation is empty OR LLM failed)
        if (!cue.source_text) return false;
        if (!cue.translated_text) return true;
        if (cue.notes?.startsWith("AI repair failed")) return true;
        return false;
      })
      .map((cue, idx, arr) => ({
        id: cue.id,
        source_text: cue.source_text,
        current_translation: cue.translated_text,
        context_before: idx > 0 ? (arr[idx - 1]?.source_text ?? "") : "",
        context_after:
          idx < arr.length - 1 ? (arr[idx + 1]?.source_text ?? "") : "",
      }));
  }, [summary]);

  // Count empty-source cues (excluded from AI repair)
  const emptySourceCount = useMemo(() => {
    if (!summary) return 0;
    return summary.needs_review_cues.filter((cue) => !cue.source_text).length;
  }, [summary]);

  const scrollToBatchPanel = useCallback(() => {
    batchPanelRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

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
              addDebug(
                `[original] loaded: ${name} (${content.length} chars)`,
              );
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
              addDebug(
                `[translated] loaded: ${name} (${content.length} chars)`,
              );
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

        {/* Debug panel — shown while no successful repair yet */}
        {!summary && debugLog.length > 0 && (
          <div className="debug-panel">
            <div className="debug-header">
              <span>D&D デバッグログ</span>
              <button
                className="debug-clear-btn"
                onClick={clearAllDebug}
              >
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
              onScrollToBatch={scrollToBatchPanel}
              aiEligibleCount={batchTargetCues.length}
              emptySourceCount={emptySourceCount}
            />
            {summary.needs_review > 0 && (
              <NeedsReviewList
                cues={summary.needs_review_cues}
                repairedCues={summary.repaired_cues}
                onRetrySuccess={markAiSuccess}
              />
            )}
            {summary.needs_review > 0 && batchTargetCues.length > 0 && (
              <div ref={batchPanelRef}>
                <BatchRepairPanel
                  targetCues={batchTargetCues}
                  llmConfig={llmConfig}
                  llmConfigured={llmConfigured}
                  translatedFileName={translatedFileName}
                  onSave={handleBatchSave}
                  onConnectionSuccess={markAiSuccess}
                />
              </div>
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
