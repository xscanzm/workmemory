import React, { useState, useEffect } from "react";
import type { WorkSegment } from "../../shared/types";
import { useConfirm } from "./ConfirmDialog";
import { XIcon, TrashIcon, StarIcon, CheckIcon } from "./Icons";

interface SegmentDetailProps {
  segment: WorkSegment;
  onUpdate: (updates: Partial<WorkSegment>) => void;
  onClose: () => void;
  onDelete: () => void;
}

export function SegmentDetail({ segment, onUpdate, onClose, onDelete }: SegmentDetailProps) {
  const confirm = useConfirm();
  const [userTitle, setUserTitle] = useState(segment.userTitle || "");
  const [userSummary, setUserSummary] = useState(segment.userSummary || "");
  const [userNote, setUserNote] = useState(segment.userNote || "");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(segment.tags || []);
  const [saved, setSaved] = useState(false);

  // 切换片段时重置表单
  useEffect(() => {
    setUserTitle(segment.userTitle || "");
    setUserSummary(segment.userSummary || "");
    setUserNote(segment.userNote || "");
    setTags(segment.tags || []);
  }, [segment.id]);

  const startTime = segment.startTime.split("T")[1]?.substring(0, 5) || "";
  const endTime = segment.endTime.split("T")[1]?.substring(0, 5) || "";
  const duration = Math.round(segment.durationSeconds / 60);

  const handleSave = () => {
    onUpdate({
      userTitle: userTitle || undefined,
      userSummary: userSummary || undefined,
      userNote: userNote || undefined,
      tags,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tag && !tags.includes(tag)) {
      const newTags = [...tags, tag];
      setTags(newTags);
      setTagInput("");
      onUpdate({ tags: newTags });
    }
  };

  const handleRemoveTag = (tag: string) => {
    const newTags = tags.filter((t) => t !== tag);
    setTags(newTags);
    onUpdate({ tags: newTags });
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: "删除片段",
      message: "确定删除此片段？可通过撤销恢复。",
      confirmText: "删除",
      danger: true,
    });
    if (ok) onDelete();
  };

  return (
    <div
      style={{
        width: 360,
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
        flexShrink: 0,
        background: "var(--color-surface)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          片段详情
          {saved && (
            <span style={{ fontSize: 11, color: "var(--color-success)", display: "flex", alignItems: "center", gap: 2 }}>
              <CheckIcon size={12} />
              已保存
            </span>
          )}
        </span>
        <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose} title="关闭">
          <XIcon size={14} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
        {/* Time & App */}
        <div className="form-group">
          <div className="form-label">时间段</div>
          <div
            className="form-input"
            style={{ background: "var(--color-bg)", fontFamily: "var(--font-mono)" }}
          >
            {startTime} - {endTime} ({duration}分钟)
          </div>
        </div>

        <div className="form-group">
          <div className="form-label">应用</div>
          <div className="form-input" style={{ background: "var(--color-bg)" }}>
            {segment.appName}
          </div>
        </div>

        <div className="form-group">
          <div className="form-label">原始窗口标题</div>
          <div
            className="form-input"
            style={{ background: "var(--color-bg)", fontSize: 12 }}
          >
            {segment.windowTitle}
          </div>
        </div>

        {/* Editable Title */}
        <div className="form-group">
          <div className="form-label">自定义标题</div>
          <input
            className="form-input"
            value={userTitle}
            onChange={(e) => setUserTitle(e.target.value)}
            onBlur={handleSave}
            placeholder={segment.windowTitle}
          />
        </div>

        {/* Editable Summary */}
        <div className="form-group">
          <div className="form-label">摘要</div>
          <textarea
            className="form-textarea"
            value={userSummary}
            onChange={(e) => setUserSummary(e.target.value)}
            onBlur={handleSave}
            placeholder={segment.ocrSummary || "添加摘要..."}
            rows={3}
          />
        </div>

        {/* Editable Note */}
        <div className="form-group">
          <div className="form-label">备注</div>
          <textarea
            className="form-textarea"
            value={userNote}
            onChange={(e) => setUserNote(e.target.value)}
            onBlur={handleSave}
            placeholder="添加备注..."
            rows={2}
          />
        </div>

        {/* Tags */}
        <div className="form-group">
          <div className="form-label">标签</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
            {tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
                <span
                  onClick={() => handleRemoveTag(tag)}
                  style={{ cursor: "pointer", fontSize: 14, lineHeight: 1 }}
                >
                  ×
                </span>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <input
              className="form-input"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddTag();
                }
              }}
              placeholder="输入标签后回车"
              style={{ flex: 1 }}
            />
            <button className="btn btn-sm" onClick={handleAddTag}>
              添加
            </button>
          </div>
        </div>

        {/* OCR Text */}
        {segment.ocrText && (
          <div className="form-group">
            <div className="form-label">
              OCR 文本
              {segment.ocrConfidence && (
                <span className="text-sm text-muted" style={{ marginLeft: 8 }}>
                  置信度: {Math.round(segment.ocrConfidence * 100)}%
                </span>
              )}
            </div>
            <div
              style={{
                padding: 10,
                background: "var(--color-bg)",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                maxHeight: 200,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                lineHeight: 1.6,
                color: "var(--color-text-secondary)",
              }}
            >
              {segment.ocrText}
            </div>
          </div>
        )}

        {/* Toggle options */}
        <div
          className="form-group"
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={segment.isSelectedForReport}
              onChange={() => {
                onUpdate({ isSelectedForReport: !segment.isSelectedForReport });
              }}
            />
            参与日报生成
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={segment.isImportant}
              onChange={() => {
                onUpdate({ isImportant: !segment.isImportant });
              }}
            />
            <StarIcon size={13} />
            标记为重点
          </label>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: "12px 16px",
          borderTop: "1px solid var(--color-border)",
        }}
      >
        <button className="btn btn-danger btn-sm" onClick={handleDelete}>
          <TrashIcon size={13} />
          删除片段
        </button>
      </div>
    </div>
  );
}
