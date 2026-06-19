import React, { useEffect, useState, useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import type { WorkStats } from "../../shared/types";
import {
  ClockIcon,
  LayoutIcon,
  DownloadIcon,
  RefreshIcon,
} from "../components/Icons";

const api = window.workmemory;

const appColors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#ef4444", "#84cc16", "#f97316", "#6366f1"];

export function WorkInsights() {
  const { showToast } = useAppStore();
  const [stats, setStats] = useState<WorkStats | null>(null);
  const [range, setRange] = useState<"week" | "month">("week");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, [range]);

  const loadStats = async () => {
    setLoading(true);
    const now = new Date();
    const endDate = now.toISOString().split("T")[0];
    const startDate = new Date(now);
    if (range === "week") {
      startDate.setDate(startDate.getDate() - 7);
    } else {
      startDate.setMonth(startDate.getMonth() - 1);
    }
    try {
      const data = await api.getWorkStats(startDate.toISOString().split("T")[0], endDate);
      setStats(data);
    } catch (err) {
      console.error("Failed to load stats:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (format: "markdown" | "json") => {
    const now = new Date();
    const endDate = now.toISOString().split("T")[0];
    const startDate = new Date(now);
    if (range === "week") startDate.setDate(startDate.getDate() - 7);
    else startDate.setMonth(startDate.getMonth() - 1);

    const result = await api.exportDateRange(
      startDate.toISOString().split("T")[0],
      endDate,
      format
    );
    if (result.success) {
      showToast(`${format === "json" ? "JSON" : "Markdown"} 导出成功`, "success");
    } else if (result.error !== "已取消") {
      showToast(result.error || "导出失败", "error");
    }
  };

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h > 0) return `${h}小时${m > 0 ? m + "分" : ""}`;
    return `${m}分钟`;
  };

  if (loading) {
    return (
      <div style={{ flex: 1, padding: 24 }}>
        <div className="skeleton" style={{ height: 200, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 150 }} />
      </div>
    );
  }

  if (!stats || stats.totalSegments === 0) {
    return (
      <div className="empty-state" style={{ flex: 1 }}>
        <div className="empty-state-icon" style={{ fontSize: 48 }}>📊</div>
        <div className="empty-state-title">暂无统计数据</div>
        <div className="empty-state-desc">
          开始记录后，这里会展示你的工作模式分析
        </div>
      </div>
    );
  }

  const maxAppDuration = Math.max(...stats.appDistribution.map((a) => a.durationSeconds), 1);
  const maxHourly = Math.max(...stats.hourlyDistribution, 1);
  const maxDaily = Math.max(...stats.dailyTrend.map((d) => d.durationSeconds), 1);

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>工作洞察</h2>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              className={`filter-chip ${range === "week" ? "active" : ""}`}
              onClick={() => setRange("week")}
            >
              近 7 天
            </button>
            <button
              className={`filter-chip ${range === "month" ? "active" : ""}`}
              onClick={() => setRange("month")}
            >
              近 30 天
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm" onClick={() => handleExport("markdown")}>
            <DownloadIcon size={13} />
            导出 Markdown
          </button>
          <button className="btn btn-sm" onClick={() => handleExport("json")}>
            <DownloadIcon size={13} />
            导出 JSON
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" onClick={loadStats} title="刷新">
            <RefreshIcon size={14} />
          </button>
        </div>
      </div>

      {/* Overview Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div className="stat-icon"><ClockIcon size={15} /></div>
            <span className="text-sm text-muted">总工作时长</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>
            {formatDuration(stats.totalDurationSeconds)}
          </div>
        </div>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div className="stat-icon"><LayoutIcon size={15} /></div>
            <span className="text-sm text-muted">片段总数</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{stats.totalSegments}</div>
        </div>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div className="stat-icon"><LayoutIcon size={15} /></div>
            <span className="text-sm text-muted">应用数量</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{stats.appDistribution.length}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* App Distribution - Pie Chart (SVG) */}
        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>应用时间分布</h3>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <AppPieChart
              data={stats.appDistribution.slice(0, 8).map((a, i) => ({
                label: a.app,
                value: a.durationSeconds,
                color: appColors[i % appColors.length],
              }))}
            />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflow: "auto" }}>
              {stats.appDistribution.slice(0, 8).map((a, i) => (
                <div key={a.app} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: appColors[i % appColors.length], flexShrink: 0 }} />
                  <span className="truncate" style={{ flex: 1 }}>{a.app}</span>
                  <span style={{ color: "var(--color-text-muted)" }}>{formatDuration(a.durationSeconds)}</span>
                  <span style={{ color: "var(--color-text-muted)", width: 36, textAlign: "right" }}>{a.percentage.toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Hourly Distribution - Bar Chart */}
        <div className="card">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>工作时段分布</h3>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 140, padding: "0 4px" }}>
            {stats.hourlyDistribution.map((val, hour) => (
              <div
                key={hour}
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  height: "100%",
                  justifyContent: "flex-end",
                }}
                title={`${hour}:00 - ${formatDuration(val)}`}
              >
                <div
                  style={{
                    width: "100%",
                    height: `${(val / maxHourly) * 100}%`,
                    minHeight: val > 0 ? 2 : 0,
                    background: val > 0
                      ? hour >= 9 && hour <= 18
                        ? "var(--color-primary)"
                        : "var(--color-text-muted)"
                      : "transparent",
                    borderRadius: "2px 2px 0 0",
                    transition: "height 0.3s",
                  }}
                />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-muted)", marginTop: 4, padding: "0 4px" }}>
            <span>0时</span>
            <span>6时</span>
            <span>12时</span>
            <span>18时</span>
            <span>23时</span>
          </div>
        </div>
      </div>

      {/* Daily Trend - Line Chart (SVG) */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>每日工作时长趋势</h3>
        <DailyTrendChart data={stats.dailyTrend} formatDuration={formatDuration} />
      </div>

      {/* Top Apps Table */}
      <div className="card">
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>应用排行</h3>
        <div>
          {stats.topApps.map((a, i) => (
            <div
              key={a.app}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 0",
                borderBottom: i < stats.topApps.length - 1 ? "1px solid var(--color-border-light)" : "none",
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-text-muted)", width: 24 }}>
                {i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{a.app}</span>
                  <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                    {formatDuration(a.durationSeconds)} · {a.count} 次
                  </span>
                </div>
                <div style={{ height: 6, background: "var(--color-bg)", borderRadius: 3, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${(a.durationSeconds / maxAppDuration) * 100}%`,
                      background: appColors[i % appColors.length],
                      borderRadius: 3,
                      transition: "width 0.3s",
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// SVG 饼图组件
function AppPieChart({ data }: { data: Array<{ label: string; value: number; color: string }> }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return <div style={{ width: 140, height: 140 }} />;

  const radius = 60;
  const centerX = 70;
  const centerY = 70;
  let currentAngle = -Math.PI / 2;

  const arcs = data.map((d) => {
    const angle = (d.value / total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + angle;
    currentAngle = endAngle;

    const x1 = centerX + radius * Math.cos(startAngle);
    const y1 = centerY + radius * Math.sin(startAngle);
    const x2 = centerX + radius * Math.cos(endAngle);
    const y2 = centerY + radius * Math.sin(endAngle);
    const largeArc = angle > Math.PI ? 1 : 0;

    return {
      path: `M ${centerX} ${centerY} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`,
      color: d.color,
    };
  });

  return (
    <svg width={140} height={140} style={{ flexShrink: 0 }}>
      {arcs.map((arc, i) => (
        <path key={i} d={arc.path} fill={arc.color} stroke="var(--color-surface)" strokeWidth={1} />
      ))}
      <circle cx={centerX} cy={centerY} r={28} fill="var(--color-surface)" />
      <text x={centerX} y={centerY - 4} textAnchor="middle" fontSize={11} fill="var(--color-text-muted)">
        总计
      </text>
      <text x={centerX} y={centerY + 10} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--color-text-primary)">
        {data.length}个
      </text>
    </svg>
  );
}

// SVG 折线图组件
function DailyTrendChart({
  data,
  formatDuration,
}: {
  data: Array<{ date: string; durationSeconds: number }>;
  formatDuration: (s: number) => string;
}) {
  if (data.length === 0) return <div className="text-sm text-muted">暂无数据</div>;

  const width = 600;
  const height = 160;
  const padding = { top: 20, right: 20, bottom: 30, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxVal = Math.max(...data.map((d) => d.durationSeconds), 1);
  const stepX = data.length > 1 ? chartWidth / (data.length - 1) : 0;

  const points = data.map((d, i) => ({
    x: padding.left + i * stepX,
    y: padding.top + chartHeight - (d.durationSeconds / maxVal) * chartHeight,
    date: d.date,
    value: d.durationSeconds,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z`;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: "100%" }}>
      <defs>
        <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.3} />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <line
          key={ratio}
          x1={padding.left}
          y1={padding.top + chartHeight * ratio}
          x2={padding.left + chartWidth}
          y2={padding.top + chartHeight * ratio}
          stroke="var(--color-border-light)"
          strokeWidth={1}
        />
      ))}

      {/* Area */}
      <path d={areaPath} fill="url(#trendGradient)" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="var(--color-primary)" strokeWidth={2} />

      {/* Points */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={3} fill="var(--color-primary)" />
          <title>{`${p.date}: ${formatDuration(p.value)}`}</title>
        </g>
      ))}

      {/* X-axis labels (every few) */}
      {points.map((p, i) => {
        const showLabel = data.length <= 7 || i % Math.ceil(data.length / 7) === 0;
        if (!showLabel) return null;
        return (
          <text
            key={i}
            x={p.x}
            y={height - 8}
            textAnchor="middle"
            fontSize={10}
            fill="var(--color-text-muted)"
          >
            {p.date.substring(5)}
          </text>
        );
      })}
    </svg>
  );
}
