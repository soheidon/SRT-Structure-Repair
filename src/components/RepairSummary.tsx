import { RepairSummary } from "../types";

interface RepairSummaryProps {
  summary: RepairSummary;
  onOpenLog: () => void;
  onScrollToBatch: () => void;
  /** Whether AI connection test or any individual retry has succeeded */
  aiConnectionOk: boolean;
  /** Number of cues eligible for AI batch repair */
  aiEligibleCount: number;
  /** Number of cues with empty source text (excluded from AI repair) */
  emptySourceCount: number;
}

export default function RepairSummaryView({
  summary,
  onOpenLog,
  onScrollToBatch,
  aiConnectionOk,
  aiEligibleCount,
  emptySourceCount,
}: RepairSummaryProps) {
  const hasProblems = summary.needs_review > 0 || summary.unmatched > 0;
  // AI is working now even though initial repair failed
  const aiRecovered = summary.llm_failed && aiConnectionOk;
  // Not eligible for AI = needs_review - AIeligible - emptySource (structural issues etc.)
  const otherIssues =
    summary.needs_review - aiEligibleCount - emptySourceCount;

  return (
    <section className="repair-summary">
      {summary.llm_failed && !aiConnectionOk ? (
        <>
          <h2 style={{ color: "#e65100" }}>
            構造修復は完了しましたが、AI修復が失敗しました
          </h2>
          <div className="llm-error-banner">
            <p>
              AI APIでエラーが発生したため、AIによる字幕修復が完了しませんでした。
              AI設定を確認し、再度修復を実行するか、以下の「一括AI修正」で翻訳を補完してください。
            </p>
          </div>
        </>
      ) : aiRecovered ? (
        <>
          <h2 style={{ color: "#2e7d32" }}>
            構造修復は完了しました
          </h2>
          <div className="ai-info-banner">
            <p>
              初回AI修復には失敗しましたが、AI接続は現在利用可能です。
              下の「一括AI修正」または個別「AIで修正」で未翻訳字幕をまとめて補完できます。
            </p>
          </div>
        </>
      ) : (
        <h2>
          {hasProblems
            ? "修復が完了しました（確認が必要な字幕があります）"
            : "修復が完了しました"}
        </h2>
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
          <div
            className="stat-card stat-warn clickable"
            onClick={onScrollToBatch}
            title="クリックして一括AI修正へ"
          >
            <span className="stat-value">{summary.needs_review}</span>
            <span className="stat-label">確認が必要 ↓</span>
          </div>
        )}
        {summary.unmatched > 0 && (
          <div className="stat-card stat-error">
            <span className="stat-value">{summary.unmatched}</span>
            <span className="stat-label">未一致</span>
          </div>
        )}
      </div>

      {/* Breakdown of needs-review cues */}
      {hasProblems && (
        <div className="stats-breakdown">
          {aiEligibleCount > 0 && (
            <div className="breakdown-item breakdown-ai">
              <span className="breakdown-value">{aiEligibleCount}件</span>
              <span className="breakdown-label">AI補完対象</span>
            </div>
          )}
          {emptySourceCount > 0 && (
            <div className="breakdown-item breakdown-empty">
              <span className="breakdown-value">{emptySourceCount}件</span>
              <span className="breakdown-label">空字幕（補完対象外）</span>
            </div>
          )}
          {otherIssues > 0 && (
            <div className="breakdown-item breakdown-other">
              <span className="breakdown-value">{otherIssues}件</span>
              <span className="breakdown-label">その他（構造問題等）</span>
            </div>
          )}
        </div>
      )}

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
