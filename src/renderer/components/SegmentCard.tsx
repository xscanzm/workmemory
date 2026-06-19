import React from "react";
import type { WorkSegment } from "../../shared/types";
import { StarIcon, TrashIcon } from "./Icons";

interface SegmentCardProps {
  segment: WorkSegment;
  isSelected: boolean;
  onSelect: () => void;
  onToggleSelection: () => void;
  onDelete: () => void;
}

// 应用名首字母色块
const appColors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#ef4444"];

function getAppColor(appName: string): string {
  let hash = 0;
  for (let i = 0; i < appName.length; i++) {
    hash = appName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return appColors[Math.abs(hash) % appColors.length];
}

export function SegmentCard({
  segment,
  isSelected,
  onSelect,
  onToggleSelection,
  onDelete,
}: SegmentCardProps) {
  const startTime = segment.startTime.split("T")[1]?.substring(0, 5) || "";
  const endTime = segment.endTime.split("T")[1]?.substring(0, 5) || "";
  const duration = Math.round(segment.durationSeconds / 60);
  const title = segment.userTitle || segment.windowTitle;
  const appColor = getAppColor(segment.appName);

  const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
    ocr_done: { label: "已识别", color: "#10b981", bg: "#ecfdf5" },
    ocr_failed: { label: "识别失败", color: "#ef4444", bg: "#fef2f2" },
    no_text: { label: "无文本", color: "#f59e0b", bg: "#fffbeb" },
    pending: { label: "待处理", color: "#9ca3af", bg: "#f3f4f6" },
    private: { label: "隐私", color: "#8b5cf6", bg: "#f5f3ff" },
  };
  const status = statusConfig[segment.sourceStatus] || statusConfig.pending;

  return (
    <div
      className={`segment-card ${isSelected ? "selected" : ""} ${segment.isPrivate ? "private" : ""}`}
      style={{ opacity: segment.isDeleted ? 0.5 : 1 }}
      onClick={onSelect}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={segment.isSelectedForReport}
          onChange={(e) => {
            e.stopPropagation();
            onToggleSelection();
          }}
          style={{ marginTop: 3, flexShrink: 0, cursor: "pointer" }}
        />

        {/* App Color Dot */}
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: appColor,
            marginTop: 6,
            flexShrink: 0,
          }}
        />

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Time & Duration & Status */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 11,
                color: "var(--color-text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {startTime} - {endTime}
            </span>
            {duration > 0 && (
              <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                · {duration}分钟
              </span>
            )}
            <span
              style={{
                fontSize: 10,
                padding: "1px 6px",
                borderRadius: 10,
                background: status.bg,
                color: status.color,
                fontWeight: 500,
              }}
            >
              {status.label}
            </span>
            {segment.isImportant && (
              <StarIcon size={12} className="text-muted" />
            )}
          </div>

          {/* App & Title */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="app-badge">{segment.appName}</span>
            <span className="truncate" style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>
              {title}
            </span>
          </div>

          {/* Summary */}
          {(segment.userSummary || segment.ocrSummary) && (
            <div
              style={{
                fontSize: 12,
                color: "var(--color-text-secondary)",
                marginTop: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                lineHeight: 1.5,
              }}
            >
              {segment.userSummary || segment.ocrSummary}
            </div>
          )}

          {/* Tags */}
          {segment.tags.length > 0 && (
            <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
              {segment.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Delete button */}
        <button
          className="btn btn-ghost btn-sm btn-icon"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{ flexShrink: 0, color: "var(--color-text-muted)" }}
          title="删除"
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </div>
  );
}
