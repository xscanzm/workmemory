import React, { useEffect, useState, useRef, useCallback } from "react";
import type { SegmentSearchResult } from "../../shared/types";

const api = window.workmemory;

export function MiniSearch() {
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SegmentSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // autoFocus
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 防抖搜索
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (!keyword.trim()) {
      setResults([]);
      return;
    }
    debounceTimer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.memorySearchInstant(keyword);
        setResults(data || []);
        setSelectedIndex(0);
      } catch (err) {
        console.error("MiniSearch error:", err);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [keyword]);

  // 键盘交互
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // 发送隐藏信号 - 通过 blur 隐藏（窗口失焦自动隐藏）
      (window as any).blur();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected) {
        const text = selected.segment.ocrText || selected.segment.windowTitle || "";
        navigator.clipboard.writeText(text).then(() => {
          (window as any).blur(); // 复制后隐藏
        });
      }
    }
  }, [results, selectedIndex]);

  return (
    <div className="glass-search-panel" style={{ width: "100%", height: "100%", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {/* 搜索框 */}
      <div style={{ padding: "20px 24px 12px" }}>
        <input
          ref={inputRef}
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="搜索记忆..."
          style={{
            width: "100%",
            padding: "12px 16px",
            fontSize: 18,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--color-text)",
            borderRadius: 8,
          }}
        />
      </div>

      {/* 横向流卡片容器 */}
      <div className="mini-search-carousel" style={{ flex: 1, overflowX: "auto", overflowY: "hidden", padding: "0 24px 20px", display: "flex", gap: 12, alignItems: "stretch" }}>
        {loading && (
          <div style={{ color: "var(--color-text-muted)", padding: 20 }}>搜索中...</div>
        )}
        {!loading && keyword.trim() && results.length === 0 && (
          <div style={{ color: "var(--color-text-muted)", padding: 20 }}>无匹配记忆</div>
        )}
        {!loading && results.map((item, idx) => {
          const seg = item.segment;
          return (
            <div
              key={seg.id}
              className={`mini-search-card ${idx === selectedIndex ? "selected" : ""}`}
              style={{
                minWidth: 200,
                maxWidth: 240,
                padding: 14,
                borderRadius: 10,
                background: "rgba(255,255,255,0.6)",
                border: idx === selectedIndex ? "2px solid #3b82f6" : "1px solid rgba(0,0,0,0.06)",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                transition: "all 0.2s ease",
              }}
              onClick={() => setSelectedIndex(idx)}
            >
              <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                {seg.startTime.split("T")[1]?.substring(0, 5)} · {seg.appName}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)", lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {seg.userTitle || seg.windowTitle}
              </div>
              {seg.ocrText && (
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                  {seg.ocrText.substring(0, 120)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部提示 */}
      <div style={{ padding: "8px 24px", fontSize: 11, color: "var(--color-text-muted)", borderTop: "1px solid rgba(0,0,0,0.05)", display: "flex", justifyContent: "space-between" }}>
        <span>← → 切换 · Enter 复制 · Esc 关闭</span>
        <span>{results.length > 0 && `${selectedIndex + 1} / ${results.length}`}</span>
      </div>
    </div>
  );
}
