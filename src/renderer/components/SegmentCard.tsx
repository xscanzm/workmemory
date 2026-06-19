import React, { useState, useRef, useEffect } from "react";
import type { WorkSegment } from "../../shared/types";
import { StarIcon, TrashIcon, SparklesIcon, XIcon } from "./Icons";

const api = window.workmemory;

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

// 文件绝对路径转 file:// URL（用于在 <img> 中加载本地截图）
function filePathToUrl(p: string): string {
  if (!p) return "";
  if (p.startsWith("file://")) return p;
  return `file://${p.replace(/\\/g, "/")}`;
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

  // 时光微缩院：hover 播放帧
  const [frames, setFrames] = useState<string[]>([]);
  const [currentFrame, setCurrentFrame] = useState(0);
  // 闪电萃取
  const [extractResult, setExtractResult] = useState<{ goldSentence: string; tags: string[] } | null>(null);
  const [extracting, setExtracting] = useState(false);

  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (playInterval.current) clearInterval(playInterval.current);
    };
  }, []);

  // 鼠标进入：200ms 后获取时光倒带帧并循环播放
  const handleMouseEnter = () => {
    hoverTimer.current = setTimeout(async () => {
      try {
        const result = await api.memoryGetTimelapse(segment.id, Date.now());
        if (result && result.length > 0) {
          setFrames(result);
          setCurrentFrame(0);
          playInterval.current = setInterval(() => {
            setCurrentFrame((prev) => (prev + 1) % result.length);
          }, 450);
        }
      } catch (err) {
        console.error("Timelapse fetch failed:", err);
      }
    }, 200);
  };

  // 鼠标离开：精准清理定时器与状态
  const handleMouseLeave = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (playInterval.current) {
      clearInterval(playInterval.current);
      playInterval.current = null;
    }
    setFrames([]);
    setCurrentFrame(0);
  };

  // 闪电萃取：调用 AI 萃取金句与标签，失败降级为规则提取
  const handleExtract = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (extracting) return;
    setExtracting(true);
    setExtractResult(null);
    const ocrText = segment.ocrText || segment.windowTitle || "";
    try {
      const result = await api.aiExtractInsight(ocrText);
      if (result && result.goldSentence) {
        setExtractResult(result);
      } else {
        // 降级：规则提取（OCR 前 25 字 + 应用名标签）
        setExtractResult({
          goldSentence: ocrText.substring(0, 25).replace(/\s+/g, " ").trim() || "无有效内容",
          tags: [segment.appName],
        });
      }
    } catch (err) {
      // 降级：规则提取（OCR 前 25 字 + 应用名标签）
      setExtractResult({
        goldSentence: ocrText.substring(0, 25).replace(/\s+/g, " ").trim() || "无有效内容",
        tags: [segment.appName],
      });
    } finally {
      setExtracting(false);
    }
  };

  return (
    <div
      className={`segment-card ${isSelected ? "selected" : ""} ${segment.isPrivate ? "private" : ""}`}
      style={{ opacity: segment.isDeleted ? 0.5 : 1, position: "relative" }}
      onClick={onSelect}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* 闪电萃取结果 - 向上弹出的重叠层 */}
      {extractResult && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            right: 0,
            marginBottom: 4,
            background: "var(--color-bg-elevated, #ffffff)",
            border: "1px solid var(--color-border, #e5e7eb)",
            borderRadius: 8,
            padding: 10,
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            zIndex: 20,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <SparklesIcon size={12} style={{ color: "#f59e0b" }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-text-secondary)" }}>
                闪电萃取
              </span>
            </div>
            <button
              className="btn btn-ghost btn-sm btn-icon"
              onClick={(e) => {
                e.stopPropagation();
                setExtractResult(null);
              }}
              style={{ color: "var(--color-text-muted)", padding: 0, width: 18, height: 18 }}
              title="关闭"
            >
              <XIcon size={12} />
            </button>
          </div>
          <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, lineHeight: 1.5 }}>
            {extractResult.goldSentence}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {extractResult.tags.map((tag, i) => (
              <span key={i} className="tag" style={{ fontSize: 10 }}>
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 时光倒带 - hover 帧预览（循环播放） */}
      {frames.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: 4,
            right: 78,
            width: 80,
            height: 50,
            borderRadius: 4,
            overflow: "hidden",
            border: "1px solid var(--color-border, #e5e7eb)",
            zIndex: 10,
            boxShadow: "0 2px 6px rgba(0,0,0,0.1)",
          }}
        >
          <img
            src={filePathToUrl(frames[currentFrame] || "")}
            alt="时光倒带"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        </div>
      )}

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

        {/* 魔棒按钮 + Delete button */}
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button
            className="btn btn-ghost btn-sm btn-icon"
            onClick={handleExtract}
            style={{ color: extracting ? "#f59e0b" : "var(--color-text-muted)" }}
            title="闪电萃取"
            disabled={extracting}
          >
            <SparklesIcon size={14} />
          </button>
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
    </div>
  );
}
