import { RepairSummary, LlmConfig } from "../types";
import { invoke } from "@tauri-apps/api/core";

interface RepairControlsProps {
  originalFileName: string | null;
  originalContent: string | null;
  translatedFileName: string | null;
  translatedContent: string | null;
  isRepairing: boolean;
  llmConfigured: boolean;
  llmConfig: LlmConfig | null;
  providerName: string;
  onRepairStart: () => void;
  onRepairComplete: (summary: RepairSummary) => void;
  onRepairError: (error: string) => void;
  onOpenSettings: () => void;
}

export default function RepairControls({
  originalFileName,
  originalContent,
  translatedFileName,
  translatedContent,
  isRepairing,
  llmConfigured,
  llmConfig,
  providerName,
  onRepairStart,
  onRepairComplete,
  onRepairError,
  onOpenSettings,
}: RepairControlsProps) {
  const canRepair =
    originalContent != null &&
    translatedContent != null &&
    !isRepairing;

  const handleRepair = async () => {
    if (!canRepair) return;

    onRepairStart();
    try {
      const summary = await invoke<RepairSummary>("repair_and_save_srt", {
        originalSrt: originalContent,
        translatedSrt: translatedContent,
        originalFileName: originalFileName ?? "original.srt",
        translatedFileName: translatedFileName ?? "translated.srt",
      });
      onRepairComplete(summary);
    } catch (e) {
      onRepairError(String(e));
    }
  };

  return (
    <div className="repair-controls">
      <div className="repair-options">
        <div className="llm-option">
          {llmConfigured ? (
            <span className="ai-status-badge configured">
              <span className="ai-status-dot" />
              {providerName} · {llmConfig?.model ?? ""}
            </span>
          ) : (
            <button
              className="ai-status-badge not-configured clickable"
              onClick={onOpenSettings}
              title="クリックしてAI設定を開く"
            >
              AI設定: 未設定
            </button>
          )}
        </div>
      </div>

      <button
        className="repair-button"
        disabled={!canRepair}
        onClick={handleRepair}
      >
        {isRepairing ? "修復中..." : "修復を開始"}
      </button>
    </div>
  );
}
