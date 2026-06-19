import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import { useConfirm } from "../components/ConfirmDialog";
import { SegmentCard } from "../components/SegmentCard";
import { SegmentDetail } from "../components/SegmentDetail";
import {
  ClockIcon,
  LayoutIcon,
  CheckIcon,
  SearchIcon,
  RefreshIcon,
  TrashIcon,
  FilterIcon,
} from "../components/Icons";
import type { WorkSegment } from "../../shared/types";

const api = window.workmemory;

export function TodayTimeline() {
  const {
    segments,
    setSegments,
    selectedSegment,
    setSelectedSegment,
    updateSegmentInList,
    removeSegmentFromList,
    recorderStatus,
    showToast,
  } = useAppStore();
  const confirm = useConfirm();

  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const today = new Date().toISOString().split("T")[0];

  const loadSegments = useCallback(async () => {
    try {
      const data = await api.getSegments(today);
      setSegments(data);
    } catch (err) {
      console.error("Failed to load segments:", err);
    } finally {
      setLoading(false);
    }
  }, [today, setSegments]);

  useEffect(() => {
    loadSegments();
    const unsubSegmentChange = api.onSegmentChange(() => {
      loadSegments();
    });
    const interval = setInterval(loadSegments, 15000);
    return () => {
      unsubSegmentChange();
      clearInterval(interval);
    };
  }, [loadSegments]);

  // 统计数据
  const stats = useMemo(() => {
    const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
    const appSet = new Set(segments.map((s) => s.appName));
    const selectedCount = segments.filter((s) => s.isSelectedForReport).length;
    return {
      totalMinutes: Math.round(totalDuration / 60),
      segmentCount: segments.length,
      appCount: appSet.size,
      selectedCount,
    };
  }, [segments]);

  // 应用列表（用于筛选）
  const appList = useMemo(() => {
    const set = new Set(segments.map((s) => s.appName));
    return Array.from(set).sort();
  }, [segments]);

  // 过滤后的片段
  const filteredSegments = useMemo(() => {
    return segments.filter((s) => {
      if (appFilter && s.appName !== appFilter) return false;
      if (statusFilter && s.sourceStatus !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const title = (s.userTitle || s.windowTitle || "").toLowerCase();
        const summary = (s.userSummary || s.ocrSummary || "").toLowerCase();
        const note = (s.userNote || "").toLowerCase();
        if (!title.includes(q) && !summary.includes(q) && !note.includes(q) && !s.appName.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [segments, searchQuery, appFilter, statusFilter]);

  // 按小时分组
  const groupedByHour = useMemo(() => {
    const groups: Record<string, WorkSegment[]> = {};
    for (const seg of filteredSegments) {
      const hour = seg.startTime.split("T")[1]?.substring(0, 2) || "00";
      const key = `${hour}:00`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(seg);
    }
    return groups;
  }, [filteredSegments]);

  const handleToggleSelection = async (id: string) => {
    const updated = await api.toggleSegmentSelection(id);
    if (updated) updateSegmentInList(updated);
  };

  const handleDelete = async (id: string) => {
    const segment = segments.find((s) => s.id === id);
    await api.deleteSegment(id);
    removeSegmentFromList(id);
    // 撤销机制：5 秒内可恢复
    showToast("片段已删除", "info", {
      label: "撤销",
      onClick: async () => {
        if (segment) {
          await api.updateSegment(id, { isDeleted: false });
          loadSegments();
          showToast("已恢复", "success");
        }
      },
    });
  };

  const handleUpdate = async (id: string, updates: Partial<WorkSegment>) => {
    const updated = await api.updateSegment(id, updates);
    if (updated) updateSegmentInList(updated);
  };

  const handleClearToday = async () => {
    const ok = await confirm({
      title: "清空今日记录",
      message: "确定要清空今天的所有记录吗？此操作可通过撤销恢复。",
      confirmText: "清空",
      danger: true,
    });
    if (ok) {
      const backup = [...segments];
      await api.clearToday(today);
      setSegments([]);
      setSelectedSegment(null);
      showToast("今日记录已清空", "info", {
        label: "撤销",
        onClick: async () => {
          for (const seg of backup) {
            await api.updateSegment(seg.id, { isDeleted: false });
          }
          loadSegments();
          showToast("已恢复", "success");
        },
      });
    }
  };

  // 批量操作
  const handleSelectAll = async () => {
    for (const seg of filteredSegments) {
      if (!seg.isSelectedForReport) {
        await api.toggleSegmentSelection(seg.id);
      }
    }
    loadSegments();
  };

  const handleDeselectAll = async () => {
    for (const seg of filteredSegments) {
      if (seg.isSelectedForReport) {
        await api.toggleSegmentSelection(seg.id);
      }
    }
    loadSegments();
  };

  const handleBatchDelete = async () => {
    const ok = await confirm({
      title: "批量删除",
      message: `确定删除当前筛选出的 ${filteredSegments.length} 个片段？可通过撤销恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (ok) {
      const backup = [...filteredSegments];
      for (const seg of filteredSegments) {
        await api.deleteSegment(seg.id);
      }
      loadSegments();
      showToast(`已删除 ${filteredSegments.length} 个片段`, "info", {
        label: "撤销",
        onClick: async () => {
          for (const seg of backup) {
            await api.updateSegment(seg.id, { isDeleted: false });
          }
          loadSegments();
          showToast("已恢复", "success");
        },
      });
    }
  };

  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes}分钟`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}小时${m}分` : `${h}小时`;
  };

  if (loading) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div className="stats-bar">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="stat-item">
              <div className="skeleton" style={{ width: 28, height: 28, borderRadius: 6 }} />
              <div>
                <div className="skeleton" style={{ width: 40, height: 14, marginBottom: 4 }} />
                <div className="skeleton" style={{ width: 30, height: 10 }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, padding: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 60, marginBottom: 8 }} />
          ))}
        </div>
      </div>
    );
  }

  if (segments.length === 0) {
    return (
      <div className="empty-state" style={{ flex: 1 }}>
        <div className="empty-state-icon">📋</div>
        <div className="empty-state-title">
          {recorderStatus === "paused"
            ? "记录已暂停"
            : recorderStatus === "initializing"
            ? "正在初始化..."
            : "今日暂无记录"}
        </div>
        <div className="empty-state-desc">
          {recorderStatus === "recording"
            ? "正在监听您的窗口活动，切换应用后将自动记录工作片段。"
            : recorderStatus === "paused"
            ? "点击顶部「恢复」按钮开始记录。"
            : "请确保应用具有窗口访问权限。"}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      {/* Timeline + Segment List */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          borderRight: selectedSegment ? "1px solid var(--color-border)" : "none",
          overflow: "hidden",
        }}
      >
        {/* Stats Bar */}
        <div className="stats-bar">
          <div className="stat-item">
            <div className="stat-icon">
              <ClockIcon size={15} />
            </div>
            <div>
              <div className="stat-value">{formatDuration(stats.totalMinutes)}</div>
              <div className="stat-label">工作时长</div>
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-icon">
              <LayoutIcon size={15} />
            </div>
            <div>
              <div className="stat-value">{stats.segmentCount}</div>
              <div className="stat-label">片段数</div>
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-icon">
              <FilterIcon size={15} />
            </div>
            <div>
              <div className="stat-value">{stats.appCount}</div>
              <div className="stat-label">应用数</div>
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-icon">
              <CheckIcon size={15} />
            </div>
            <div>
              <div className="stat-value">{stats.selectedCount}</div>
              <div className="stat-label">已选</div>
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid var(--color-border)",
            flexShrink: 0,
            flexWrap: "wrap",
          }}
        >
          <div className="search-input-wrapper" style={{ width: 200 }}>
            <span className="search-icon">
              <SearchIcon size={14} />
            </span>
            <input
              className="search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索片段..."
            />
          </div>

          <select
            className="form-input"
            style={{ width: "auto", padding: "6px 8px", fontSize: 12 }}
            value={appFilter}
            onChange={(e) => setAppFilter(e.target.value)}
          >
            <option value="">全部应用</option>
            {appList.map((app) => (
              <option key={app} value={app}>
                {app}
              </option>
            ))}
          </select>

          <select
            className="form-input"
            style={{ width: "auto", padding: "6px 8px", fontSize: 12 }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">全部状态</option>
            <option value="ocr_done">已识别</option>
            <option value="pending">待处理</option>
            <option value="no_text">无文本</option>
            <option value="ocr_failed">识别失败</option>
            <option value="private">隐私</option>
          </select>

          <div style={{ flex: 1 }} />

          <button className="btn btn-sm" onClick={handleSelectAll} title="全选当前筛选结果">
            全选
          </button>
          <button className="btn btn-sm" onClick={handleDeselectAll} title="取消全选">
            取消全选
          </button>
          <button
            className="btn btn-sm btn-danger"
            onClick={handleBatchDelete}
            disabled={filteredSegments.length === 0}
            title="删除当前筛选结果"
          >
            <TrashIcon size={13} />
            批量删除
          </button>
          <button className="btn btn-sm btn-ghost btn-icon" onClick={loadSegments} title="刷新">
            <RefreshIcon size={14} />
          </button>
        </div>

        {/* Segment List */}
        <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
          {filteredSegments.length === 0 ? (
            <div className="empty-state" style={{ padding: 32 }}>
              <div className="empty-state-title">未找到匹配的片段</div>
              <div className="empty-state-desc">尝试调整搜索关键词或筛选条件</div>
            </div>
          ) : (
            Object.entries(groupedByHour).map(([hour, hourSegments]) => (
              <div key={hour} style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--color-text-muted)",
                    marginBottom: 8,
                    paddingLeft: 4,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {hour}
                  <span style={{ fontSize: 11, fontWeight: 400 }}>
                    {hourSegments.length} 个片段
                  </span>
                </div>
                {hourSegments.map((seg) => (
                  <SegmentCard
                    key={seg.id}
                    segment={seg}
                    isSelected={selectedSegment?.id === seg.id}
                    onSelect={() => setSelectedSegment(seg)}
                    onToggleSelection={() => handleToggleSelection(seg.id)}
                    onDelete={() => handleDelete(seg.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Detail Panel */}
      {selectedSegment && (
        <SegmentDetail
          segment={selectedSegment}
          onUpdate={(updates) => handleUpdate(selectedSegment.id, updates)}
          onClose={() => setSelectedSegment(null)}
          onDelete={() => handleDelete(selectedSegment.id)}
        />
      )}
    </div>
  );
}
