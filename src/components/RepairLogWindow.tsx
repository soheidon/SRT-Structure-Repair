import { useEffect, useState } from "react";
import { RepairLogEntry } from "../types";

type TabKey = "repairs" | "process";

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  StructureRecovered: { label: "構造修復", className: "log-status-recovered" },
  LLMRepaired: { label: "AI修復", className: "log-status-llm" },
  NeedsReview: { label: "確認必要", className: "log-status-review" },
  Unmatched: { label: "未対応", className: "log-status-unmatched" },
};

interface RepairLogWindowProps {
  isOpen: boolean;
  onClose: () => void;
  entries: RepairLogEntry[];
  processLog: string[];
}

export default function RepairLogWindow({
  isOpen,
  onClose,
  entries,
  processLog,
}: RepairLogWindowProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("repairs");

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="log-window-overlay" onClick={onClose}>
      <div
        className="log-window-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="修復ログ"
      >
        <div className="log-window-header">
          <h2>修復ログ</h2>
          <button
            className="log-window-close"
            onClick={onClose}
            aria-label="閉じる"
            title="閉じる"
          >
            ✕
          </button>
        </div>

        <p className="log-window-warning">
          修復ログには字幕本文が含まれます。共有する場合は内容に注意してください。
        </p>

        <div className="log-tabs" role="tablist">
          <button
            className={`log-tab ${activeTab === "repairs" ? "active" : ""}`}
            onClick={() => setActiveTab("repairs")}
            role="tab"
            aria-selected={activeTab === "repairs"}
          >
            修復箇所
            <span className="log-tab-count">({entries.length})</span>
          </button>
          <button
            className={`log-tab ${activeTab === "process" ? "active" : ""}`}
            onClick={() => setActiveTab("process")}
            role="tab"
            aria-selected={activeTab === "process"}
          >
            全ログ
            <span className="log-tab-count">({processLog.length})</span>
          </button>
        </div>

        <div className="log-window-body">
          {activeTab === "repairs" ? (
            entries.length === 0 ? (
              <p className="empty-text">修復対象はありませんでした。</p>
            ) : (
              <div className="log-list">
                {entries.map((entry) => {
                  const statusInfo = STATUS_LABELS[entry.status] ?? {
                    label: entry.status,
                    className: "",
                  };
                  return (
                    <div key={entry.cue_id} className="log-entry">
                      <div className="log-entry-header">
                        <span className="log-cue-id">Cue #{entry.cue_id}</span>
                        <span className="log-time">
                          {entry.start} → {entry.end}
                        </span>
                        <span
                          className={`log-status-badge ${statusInfo.className}`}
                        >
                          {statusInfo.label}
                        </span>
                        {entry.confidence != null && (
                          <span className="log-confidence">
                            confidence: {(entry.confidence * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                      <div className="log-issue">{entry.issue}</div>
                      <div className="log-entry-body">
                        <div className="log-source">
                          <label>Original English</label>
                          <p>{entry.source_text || "(empty)"}</p>
                        </div>
                        <div className="log-translated">
                          <label>Japanese / Repaired</label>
                          <p>{entry.translated_after || "(empty)"}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : processLog.length === 0 ? (
            <p className="empty-text">ログはありません。</p>
          ) : (
            <pre className="process-log">
              {processLog.map((line, i) => (
                <div key={i} className="process-log-line">
                  {line}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
