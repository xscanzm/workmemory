import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import type { CalendarDayInfo, WorkSegment, DailySummary } from "../../shared/types";
import {
  ChevronRightIcon,
  ChevronDownIcon,
  RefreshIcon,
  ClockIcon,
  SparklesIcon,
  XIcon,
} from "../components/Icons";

const api = window.workmemory;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_NAMES = [
  "一月", "二月", "三月", "四月", "五月", "六月",
  "七月", "八月", "九月", "十月", "十一月", "十二月",
];

// 时长对应的颜色深度
function getHeatColor(durationSeconds: number): string {
  const minutes = durationSeconds / 60;
  if (minutes === 0) return "transparent";
  if (minutes < 30) return "rgba(59, 130, 246, 0.15)";
  if (minutes < 120) return "rgba(59, 130, 246, 0.3)";
  if (minutes < 240) return "rgba(59, 130, 246, 0.5)";
  if (minutes < 360) return "rgba(59, 130, 246, 0.7)";
  return "rgba(59, 130, 246, 0.9)";
}

export function MemoryCalendar() {
  const { showToast } = useAppStore();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [calendarDays, setCalendarDays] = useState<CalendarDayInfo[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSegments, setSelectedSegments] = useState<WorkSegment[]>([]);
  const [selectedSummary, setSelectedSummary] = useState<DailySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1;

  const loadCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const days = await api.getCalendarMonth(year, month);
      setCalendarDays(days);
    } catch (err) {
      console.error("Failed to load calendar:", err);
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    loadCalendar();
  }, [loadCalendar]);

  // 构建日历网格
  const calendarGrid = useMemo(() => {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const startWeekday = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const dayInfoMap = new Map<string, CalendarDayInfo>();
    for (const d of calendarDays) {
      dayInfoMap.set(d.date, d);
    }

    const grid: Array<{ date: string | null; info?: CalendarDayInfo }> = [];
    // 前置空白
    for (let i = 0; i < startWeekday; i++) {
      grid.push({ date: null });
    }
    // 当月每天
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      grid.push({ date: dateStr, info: dayInfoMap.get(dateStr) });
    }
    return grid;
  }, [year, month, calendarDays]);

  const handleSelectDate = async (date: string) => {
    setSelectedDate(date);
    const [segments, summary] = await Promise.all([
      api.getSegmentsByDate(date),
      api.getDailySummary(date),
    ]);
    setSelectedSegments(segments);
    setSelectedSummary(summary);
  };

  const handleGenerateSummary = async (date: string) => {
    setGeneratingSummary(true);
    try {
      const summary = await api.generateDailySummary(date, true);
      setSelectedSummary(summary);
      showToast("一句话总结已生成", "success");
      loadCalendar();
    } catch {
      showToast("生成失败", "error");
    } finally {
      setGeneratingSummary(false);
    }
  };

  const handlePrevMonth = () => {
    setCurrentDate(new Date(year, month - 2, 1));
    setSelectedDate(null);
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(year, month, 1));
    setSelectedDate(null);
  };

  const handleToday = () => {
    setCurrentDate(new Date());
    setSelectedDate(null);
  };

  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h > 0) return `${h}小时${m > 0 ? m + "分" : ""}`;
    return `${m}分钟`;
  };

  const todayStr = new Date().toISOString().split("T")[0];

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Calendar */}
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-sm btn-ghost btn-icon" onClick={handlePrevMonth} title="上个月">
              <ChevronRightIcon size={16} style={{ transform: "rotate(180deg)" }} />
            </button>
            <h2 style={{ fontSize: 18, fontWeight: 600, minWidth: 120, textAlign: "center" }}>
              {year}年 {MONTH_NAMES[month - 1]}
            </h2>
            <button className="btn btn-sm btn-ghost btn-icon" onClick={handleNextMonth} title="下个月">
              <ChevronRightIcon size={16} />
            </button>
          </div>
          <button className="btn btn-sm" onClick={handleToday}>今天</button>
        </div>

        {/* Weekday header */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, marginBottom: 6 }}>
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              style={{
                textAlign: "center",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--color-text-muted)",
                padding: "6px 0",
              }}
            >
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
          {calendarGrid.map((cell, idx) => {
            if (!cell.date) {
              return <div key={idx} />;
            }
            const info = cell.info;
            const isToday = cell.date === todayStr;
            const isSelected = cell.date === selectedDate;
            const day = parseInt(cell.date.split("-")[2]);

            return (
              <button
                key={idx}
                onClick={() => handleSelectDate(cell.date!)}
                style={{
                  aspectRatio: "1.2",
                  borderRadius: "var(--radius-md)",
                  border: isSelected
                    ? "2px solid var(--color-primary)"
                    : isToday
                    ? "2px solid var(--color-primary-lighter)"
                    : "1px solid var(--color-border)",
                  background: info ? getHeatColor(info.totalDurationSeconds) : "var(--color-surface)",
                  cursor: "pointer",
                  padding: 6,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  transition: "all 0.15s",
                  position: "relative",
                  opacity: loading ? 0.5 : 1,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: isToday ? 700 : 500,
                    color: info ? (info.totalDurationSeconds > 14400 ? "white" : "var(--color-text-primary)") : "var(--color-text-muted)",
                  }}
                >
                  {day}
                </span>
                {info && (
                  <div style={{ width: "100%" }}>
                    <div
                      style={{
                        fontSize: 10,
                        color: info.totalDurationSeconds > 14400 ? "rgba(255,255,255,0.9)" : "var(--color-text-secondary)",
                        fontWeight: 500,
                      }}
                    >
                      {formatDuration(info.totalDurationSeconds)}
                    </div>
                    {info.summary && (
                      <div
                        style={{
                          fontSize: 9,
                          color: info.totalDurationSeconds > 14400 ? "rgba(255,255,255,0.8)" : "var(--color-text-muted)",
                          marginTop: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          lineHeight: 1.3,
                        }}
                      >
                        {info.summary}
                      </div>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20, fontSize: 11, color: "var(--color-text-muted)" }}>
          <span>少</span>
          {[0.15, 0.3, 0.5, 0.7, 0.9].map((opacity) => (
            <div
              key={opacity}
              style={{
                width: 16,
                height: 16,
                borderRadius: 3,
                background: `rgba(59, 130, 246, ${opacity})`,
              }}
            />
          ))}
          <span>多</span>
        </div>
      </div>

      {/* Detail Panel */}
      {selectedDate && (
        <div
          style={{
            width: 400,
            borderLeft: "1px solid var(--color-border)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {/* Detail Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{selectedDate} 记忆</span>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setSelectedDate(null)}>
              <XIcon size={14} />
            </button>
          </div>

          {/* Summary Card */}
          <div style={{ padding: 16, borderBottom: "1px solid var(--color-border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 4 }}>
                <SparklesIcon size={13} />
                一句话总结
              </span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => handleGenerateSummary(selectedDate)}
                disabled={generatingSummary || selectedSegments.length === 0}
              >
                {generatingSummary ? <RefreshIcon size={12} className="spin" /> : <RefreshIcon size={12} />}
                {selectedSummary ? "重新生成" : "生成"}
              </button>
            </div>
            {selectedSummary ? (
              <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--color-text-primary)" }}>
                {selectedSummary.summary}
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6 }}>
                  {selectedSummary.generatedBy === "ai" ? "AI 生成" : "规则提取"} ·
                  共 {selectedSummary.segmentCount} 个片段 · {formatDuration(selectedSummary.totalDurationSeconds)}
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted">
                {selectedSegments.length > 0 ? "点击「生成」创建一句话总结" : "当天无数据"}
              </div>
            )}
          </div>

          {/* Segments List */}
          <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
            {selectedSegments.length === 0 ? (
              <div className="empty-state" style={{ padding: 32 }}>
                <div className="empty-state-title">当天无记录</div>
              </div>
            ) : (
              selectedSegments.map((seg) => {
                const start = seg.startTime.split("T")[1]?.substring(0, 5) || "";
                const end = seg.endTime.split("T")[1]?.substring(0, 5) || "";
                const dur = Math.round(seg.durationSeconds / 60);
                return (
                  <div
                    key={seg.id}
                    className="segment-card"
                    style={{ marginBottom: 6 }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                        {start}-{end}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>· {dur}分</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="app-badge" style={{ fontSize: 10 }}>{seg.appName}</span>
                    </div>
                    <div className="truncate" style={{ fontSize: 13, fontWeight: 500, marginTop: 4 }}>
                      {seg.userTitle || seg.windowTitle}
                    </div>
                    {(seg.userSummary || seg.ocrSummary) && (
                      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2 }}>
                        {seg.userSummary || seg.ocrSummary}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
