import React, { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import type { InsightCard, SmartReminder, AnomalyDetection, InsightType, InsightSeverity } from "../../shared/types";
import {
  SparklesIcon,
  BellIcon,
  AlertIcon,
  RefreshIcon,
  XIcon,
  TrendingUpIcon,
  ClockIcon,
  CoffeeIcon,
  ZapIcon,
  InfoIcon,
} from "../components/Icons";

const api = window.workmemory;

export function ProactiveInsights() {
  const { showToast, setRoute } = useAppStore();
  const [insights, setInsights] = useState<InsightCard[]>([]);
  const [reminders, setReminders] = useState<SmartReminder[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyDetection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [ins, rems, anoms] = await Promise.all([
        api.insightsGet(),
        api.insightsGetReminders(),
        api.insightsGetAnomalies(),
      ]);
      setInsights(ins);
      setReminders(rems);
      setAnomalies(anoms);
    } catch (error) {
      console.error("加载洞察失败:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await api.insightsRefresh();
      await loadData();
      showToast(`已生成 ${result.insights} 条洞察，${result.anomalies} 条异常检测`, "success");
    } catch (error) {
      showToast("刷新失败", "error");
    } finally {
      setRefreshing(false);
    }
  };

  const handleDismissInsight = async (id: string) => {
    await api.insightsDismiss(id);
    setInsights(insights.filter((i) => i.id !== id));
  };

  const handleDismissReminder = async (id: string) => {
    await api.insightsDismissReminder(id);
    setReminders(reminders.filter((r) => r.id !== id));
  };

  const handleInsightAction = (insight: InsightCard) => {
    if (insight.actionRoute) {
      setRoute(insight.actionRoute);
    }
  };

  const hasContent = insights.length > 0 || reminders.length > 0 || anomalies.length > 0;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "16px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <SparklesIcon size={18} />
            主动智能
          </h2>
          <div className="text-sm text-muted" style={{ marginTop: 2 }}>
            洞察卡片 · 智能提醒 · 异常检测
          </div>
        </div>
        <button className="btn btn-sm btn-primary" onClick={handleRefresh} disabled={refreshing}>
          <RefreshIcon size={14} className={refreshing ? "spin" : ""} />
          {refreshing ? "分析中..." : "刷新洞察"}
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 24px" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--color-text-muted)" }}>
            加载中...
          </div>
        ) : !hasContent ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--color-text-muted)" }}>
            <SparklesIcon size={48} style={{ opacity: 0.3, marginBottom: 16 }} />
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>暂无洞察</div>
            <div style={{ fontSize: 12 }}>点击右上角"刷新洞察"分析你的工作模式</div>
          </div>
        ) : (
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            {/* Reminders */}
            {reminders.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <SectionTitle icon={<BellIcon size={14} />} title="智能提醒" count={reminders.length} />
                {reminders.map((reminder) => (
                  <ReminderBanner
                    key={reminder.id}
                    reminder={reminder}
                    onDismiss={() => handleDismissReminder(reminder.id)}
                  />
                ))}
              </div>
            )}

            {/* Anomalies */}
            {anomalies.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <SectionTitle icon={<AlertIcon size={14} />} title="异常检测" count={anomalies.length} />
                {anomalies.map((anomaly) => (
                  <AnomalyCardView key={anomaly.id} anomaly={anomaly} />
                ))}
              </div>
            )}

            {/* Insights */}
            {insights.length > 0 && (
              <div>
                <SectionTitle icon={<SparklesIcon size={14} />} title="工作洞察" count={insights.length} />
                {insights.map((insight) => (
                  <InsightCardView
                    key={insight.id}
                    insight={insight}
                    onDismiss={() => handleDismissInsight(insight.id)}
                    onAction={() => handleInsightAction(insight)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ icon, title, count }: { icon: React.ReactNode; title: string; count: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, fontSize: 14, fontWeight: 600, color: "var(--color-text-primary)" }}>
      {icon}
      {title}
      <span style={{ fontSize: 12, color: "var(--color-text-muted)", fontWeight: 400 }}>({count})</span>
    </div>
  );
}

function getInsightIcon(type: InsightType): React.ReactNode {
  switch (type) {
    case "work_pattern": return <TrendingUpIcon size={14} />;
    case "time_anomaly": return <ClockIcon size={14} />;
    case "app_usage": return <ZapIcon size={14} />;
    case "productivity": return <SparklesIcon size={14} />;
    case "break_reminder": return <CoffeeIcon size={14} />;
    case "focus_session": return <ZapIcon size={14} />;
    case "comparison": return <TrendingUpIcon size={14} />;
    default: return <InfoIcon size={14} />;
  }
}

function getSeverityLabel(severity: InsightSeverity): string {
  switch (severity) {
    case "info": return "信息";
    case "warning": return "注意";
    case "positive": return "积极";
  }
}

function InsightCardView({
  insight,
  onDismiss,
  onAction,
}: {
  insight: InsightCard;
  onDismiss: () => void;
  onAction: () => void;
}) {
  return (
    <div className={`insight-card severity-${insight.severity}`}>
      <div className="insight-card-header">
        <div className="insight-card-title">
          {getInsightIcon(insight.type)}
          {insight.title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className={`insight-severity-badge ${insight.severity}`}>
            {getSeverityLabel(insight.severity)}
          </span>
          <button
            className="btn btn-ghost btn-sm btn-icon"
            onClick={onDismiss}
            title="忽略"
            style={{ padding: 2 }}
          >
            <XIcon size={12} />
          </button>
        </div>
      </div>
      <div className="insight-card-content">{insight.content}</div>
      {insight.actionLabel && (
        <div className="insight-card-actions">
          <button className="btn btn-sm btn-primary" onClick={onAction}>
            {insight.actionLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function ReminderBanner({
  reminder,
  onDismiss,
}: {
  reminder: SmartReminder;
  onDismiss: () => void;
}) {
  return (
    <div className="reminder-banner">
      <div className="reminder-banner-icon">
        <BellIcon size={16} />
      </div>
      <div className="reminder-banner-content">
        <div className="reminder-banner-title">{reminder.title}</div>
        <div className="reminder-banner-message">{reminder.message}</div>
      </div>
      <button
        className="btn btn-ghost btn-sm btn-icon"
        onClick={onDismiss}
        title="忽略"
        style={{ padding: 2 }}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

function AnomalyCardView({ anomaly }: { anomaly: AnomalyDetection; onDismiss?: () => void }) {
  return (
    <div className={`anomaly-card severity-${anomaly.severity}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <AlertIcon size={14} style={{ color: anomaly.severity === "high" ? "var(--color-danger)" : "var(--color-warning)" }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{anomaly.title}</span>
        <span style={{
          fontSize: 10,
          padding: "1px 6px",
          borderRadius: 8,
          background: anomaly.severity === "high" ? "var(--color-danger)" : "var(--color-warning)",
          color: "white",
          marginLeft: "auto",
        }}>
          {anomaly.severity === "high" ? "高" : anomaly.severity === "medium" ? "中" : "低"}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
        {anomaly.description}
      </div>
    </div>
  );
}
