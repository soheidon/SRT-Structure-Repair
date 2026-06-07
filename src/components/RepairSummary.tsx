import { RepairSummary } from "../types";

interface RepairSummaryProps {
  summary: RepairSummary;
  onOpenLog: () => void;
}

export default function RepairSummaryView({
  summary,
  onOpenLog,
}: RepairSummaryProps) {
  const hasProblems = summary.needs_review > 0 || summary.unmatched > 0;

  return (
    <section className="repair-summary">
      <h2 style={{ color: hasProblems ? "#e65100" : "#2e7d32" }}>
        {hasProblems
          ? "構造修復は完了しました（確認が必要な字幕があります）"
          : "構造修復は完了しました"}
      </h2>

      {hasProblems && (
        <div className="ai-info-banner">
          <p>
            AIによる字幕補完は下の「一括AI修正」または個別の「AIで修正」から実行できます。
          </p>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-value">{summary.total_cues}</span>
          <span className="stat-label">字幕総数</span>
        </div>
        <div className="stat-card stat-ok">
          <span className="stat-value">{summary.auto_matched}</span>
          <span className="stat-label">自動一致</span>
        </div>
        <div className="stat-card stat-ok">
          <span className="stat-value">{summary.structure_recovered}</span>
          <span className="stat-label">構造修復</span>
        </div>
        {summary.llm_repaired > 0 && (
          <div className="stat-card stat-info">
            <span className="stat-value">{summary.llm_repaired}</span>
            <span className="stat-label">AI修復</span>
          </div>
        )}
        {summary.needs_review > 0 && (
          <div className="stat-card stat-warn">
            <span className="stat-value">{summary.needs_review}</span>
            <span className="stat-label">確認が必要</span>
          </div>
        )}
        {summary.unmatched > 0 && (
          <div className="stat-card stat-error">
            <span className="stat-value">{summary.unmatched}</span>
            <span className="stat-label">未一致</span>
          </div>
        )}
      </div>

      <div className="output-paths">
        <div className="output-path">
          <span className="output-label">修復済みSRT: </span>
          <code className="output-value">{summary.output_path}</code>
        </div>
        <div className="output-path">
          <span className="output-label">修復ログ: </span>
          <code className="output-value">{summary.log_path}</code>
        </div>
      </div>

      <button className="open-log-button" onClick={onOpenLog}>
        ログを開く
      </button>
    </section>
  );
}
