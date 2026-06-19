import React, { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import type { MemoryGraphData, WorkSegment } from "../../shared/types";
import {
  UsersIcon,
  TagIcon,
  CalendarIcon,
  RefreshIcon,
  ClockIcon,
} from "../components/Icons";

const api = window.workmemory;

type ViewType = "people" | "events" | "timeline";

export function MemoryGraph() {
  const { showToast } = useAppStore();
  const [view, setView] = useState<ViewType>("people");
  const [graphData, setGraphData] = useState<MemoryGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [relatedSegments, setRelatedSegments] = useState<WorkSegment[]>([]);
  const [loadingSegments, setLoadingSegments] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await api.getMemoryGraph();
      setGraphData(data);
    } catch (error) {
      console.error("加载记忆图谱失败:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleEntityClick = async (entity: string, type: ViewType) => {
    setSelectedEntity(entity);
    setLoadingSegments(true);
    try {
      const segments =
        type === "people"
          ? await api.getSegmentsByPerson(entity)
          : await api.getSegmentsByEvent(entity);
      setRelatedSegments(segments);
    } catch (error) {
      console.error("加载关联片段失败:", error);
    } finally {
      setLoadingSegments(false);
    }
  };

  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours > 0) return `${hours}小时${minutes > 0 ? minutes + "分" : ""}`;
    return `${minutes}分钟`;
  };

  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const getAvatarChar = (name: string): string => {
    return name.charAt(0).toUpperCase();
  };

  const views = [
    { key: "people" as ViewType, label: "人", icon: <UsersIcon size={14} /> },
    { key: "events" as ViewType, label: "事", icon: <TagIcon size={14} /> },
    { key: "timeline" as ViewType, label: "时间", icon: <CalendarIcon size={14} /> },
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "16px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <UsersIcon size={18} />
            记忆图谱
          </h2>
          <div className="text-sm text-muted" style={{ marginTop: 2 }}>
            人 · 事 · 时间 三维度串联你的工作记忆
          </div>
        </div>
        <button className="btn btn-sm" onClick={loadData} disabled={loading}>
          <RefreshIcon size={14} className={loading ? "spin" : ""} />
          刷新
        </button>
      </div>

      {/* View Tabs */}
      <div style={{ padding: "12px 24px 0" }}>
        <div className="graph-view-tabs">
          {views.map((v) => (
            <button
              key={v.key}
              className={`graph-view-tab ${view === v.key ? "active" : ""}`}
              onClick={() => {
                setView(v.key);
                setSelectedEntity(null);
                setRelatedSegments([]);
              }}
            >
              {v.icon}
              <span style={{ marginLeft: 4 }}>{v.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 24px" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>
            加载中...
          </div>
        ) : !graphData ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-muted)" }}>
            暂无数据
          </div>
        ) : (
          <div style={{ display: "flex", gap: 24 }}>
            {/* Entity List */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {view === "people" && (
                <PeopleView
                  data={graphData.people}
                  selectedEntity={selectedEntity}
                  onEntityClick={(name) => handleEntityClick(name, "people")}
                  formatDuration={formatDuration}
                  formatTime={formatTime}
                  getAvatarChar={getAvatarChar}
                />
              )}
              {view === "events" && (
                <EventsView
                  data={graphData.events}
                  selectedEntity={selectedEntity}
                  onEntityClick={(name) => handleEntityClick(name, "events")}
                  formatDuration={formatDuration}
                  formatTime={formatTime}
                />
              )}
              {view === "timeline" && (
                <TimelineView
                  data={graphData.timeline}
                  formatDuration={formatDuration}
                />
              )}
            </div>

            {/* Related Segments */}
            {selectedEntity && (
              <div style={{ width: 360, flexShrink: 0, borderLeft: "1px solid var(--color-border)", paddingLeft: 24 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                  <ClockIcon size={14} />
                  关联片段
                  <span style={{ fontSize: 12, color: "var(--color-text-muted)", fontWeight: 400 }}>
                    ({relatedSegments.length})
                  </span>
                </div>
                {loadingSegments ? (
                  <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>加载中...</div>
                ) : relatedSegments.length === 0 ? (
                  <div style={{ color: "var(--color-text-muted)", fontSize: 13 }}>暂无关联片段</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {relatedSegments.slice(0, 20).map((seg) => (
                      <div key={seg.id} className="card" style={{ padding: 10, marginBottom: 0 }}>
                        <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 4 }}>
                          {seg.date} · {seg.startTime.split("T")[1]?.substring(0, 5)} - {seg.endTime.split("T")[1]?.substring(0, 5)}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {seg.userTitle || seg.windowTitle}
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 8, background: "var(--color-bg)", color: "var(--color-text-secondary)" }}>
                            {seg.appName}
                          </span>
                          {seg.event && (
                            <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 8, background: "var(--color-primary-light)", color: "var(--color-primary)" }}>
                              {seg.event}
                            </span>
                          )}
                          {seg.people?.map((p) => (
                            <span key={p} style={{ fontSize: 11, padding: "1px 6px", borderRadius: 8, background: "var(--color-success-light)", color: "var(--color-success)" }}>
                              @{p}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// === People View ===
function PeopleView({
  data,
  selectedEntity,
  onEntityClick,
  formatDuration,
  formatTime,
  getAvatarChar,
}: {
  data: MemoryGraphData["people"];
  selectedEntity: string | null;
  onEntityClick: (name: string) => void;
  formatDuration: (s: number) => string;
  formatTime: (iso: string) => string;
  getAvatarChar: (name: string) => string;
}) {
  if (data.length === 0) {
    return <EmptyState message="还没有识别到人物。系统会从聊天、邮件、会议等应用中自动提取联系人。" />;
  }
  return (
    <div>
      {data.map((person) => (
        <div
          key={person.name}
          className={`graph-entity-card ${selectedEntity === person.name ? "active" : ""}`}
          style={selectedEntity === person.name ? { borderColor: "var(--color-primary)", background: "var(--color-primary-light)" } : {}}
          onClick={() => onEntityClick(person.name)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="graph-entity-avatar">{getAvatarChar(person.name)}</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{person.name}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                {person.segmentCount} 次互动 · 最后联系 {formatTime(person.lastSeen)}
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-primary)" }}>
              {formatDuration(person.totalDurationSeconds)}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>总时长</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// === Events View ===
function EventsView({
  data,
  selectedEntity,
  onEntityClick,
  formatDuration,
  formatTime,
}: {
  data: MemoryGraphData["events"];
  selectedEntity: string | null;
  onEntityClick: (name: string) => void;
  formatDuration: (s: number) => string;
  formatTime: (iso: string) => string;
}) {
  if (data.length === 0) {
    return <EmptyState message="还没有识别到事件。系统会从文档、项目、会议中自动提取工作事件。" />;
  }
  return (
    <div>
      {data.map((event) => (
        <div
          key={event.name}
          className={`graph-entity-card ${selectedEntity === event.name ? "active" : ""}`}
          style={selectedEntity === event.name ? { borderColor: "var(--color-primary)", background: "var(--color-primary-light)" } : {}}
          onClick={() => onEntityClick(event.name)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="graph-entity-avatar" style={{ background: "var(--color-success-light)", color: "var(--color-success)" }}>
              <TagIcon size={16} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{event.name}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                {event.date} · {event.segmentCount} 个片段 · {formatTime(event.lastSeen)}
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-success)" }}>
              {formatDuration(event.totalDurationSeconds)}
            </div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>总时长</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// === Timeline View ===
function TimelineView({
  data,
  formatDuration,
}: {
  data: MemoryGraphData["timeline"];
  formatDuration: (s: number) => string;
}) {
  if (data.length === 0) {
    return <EmptyState message="还没有时间线数据。" />;
  }
  const maxDuration = Math.max(...data.map((d) => d.totalDurationSeconds), 1);
  return (
    <div>
      {data.map((day) => {
        const widthPercent = Math.max(10, (day.totalDurationSeconds / maxDuration) * 100);
        const d = new Date(day.date);
        const weekDay = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
        return (
          <div key={day.date} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 500 }}>
                {day.date} <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>周{weekDay}</span>
              </span>
              <span style={{ color: "var(--color-text-secondary)" }}>
                {formatDuration(day.totalDurationSeconds)} · {day.segmentCount} 片段
              </span>
            </div>
            <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-sm)", height: 24, overflow: "hidden" }}>
              <div
                style={{
                  width: `${widthPercent}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, var(--color-primary), var(--color-primary-hover))",
                  borderRadius: "var(--radius-sm)",
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: 60, color: "var(--color-text-muted)" }}>
      <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>○</div>
      <div style={{ fontSize: 13, maxWidth: 300, margin: "0 auto", lineHeight: 1.6 }}>{message}</div>
    </div>
  );
}
