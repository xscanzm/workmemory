import React, { useEffect, useState, useMemo, useCallback } from "react";
import { useAppStore } from "../stores/app-store";
import type { SegmentSearchResult, WorkSegment } from "../../shared/types";
import {
  SearchIcon,
  ClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  XIcon,
} from "../components/Icons";

const api = window.workmemory;

export function MemorySearch() {
  const { showToast, setSelectedSegment, setRoute } = useAppStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SegmentSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [groupByDate, setGroupByDate] = useState(true);
  const [searched, setSearched] = useState(false);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  // 防抖搜索
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api.searchSegments(query.trim());
        setResults(data);
        setSearched(true);
        // 默认展开所有日期
        const dates = new Set<string>();
        for (const r of data) {
          dates.add(r.segment.date);
        }
        setExpandedDates(dates);
      } catch (err) {
        console.error("Search failed:", err);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // 按日期分组（主题串联呈现）
  const groupedResults = useMemo(() => {
    if (!groupByDate) return null;
    const groups = new Map<string, SegmentSearchResult[]>();
    for (const r of results) {
      if (!groups.has(r.segment.date)) groups.set(r.segment.date, []);
      groups.get(r.segment.date)!.push(r);
    }
    // 按日期倒序
    return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [results, groupByDate]);

  const toggleDate = (date: string) => {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const handleViewSegment = (segment: WorkSegment) => {
    setSelectedSegment(segment);
    setRoute("/");
  };

  const highlightText = (text: string, keyword: string) => {
    if (!keyword) return text;
    const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.substring(0, idx)}
        <mark style={{ background: "var(--color-warning-light)", padding: "0 2px", borderRadius: 2 }}>
          {text.substring(idx, idx + keyword.length)}
        </mark>
        {text.substring(idx + keyword.length)}
      </>
    );
  };

  const formatDuration = (seconds: number) => {
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m}分`;
    return `${Math.floor(m / 60)}小时${m % 60 > 0 ? (m % 60) + "分" : ""}`;
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Search Header */}
      <div
        style={{
          padding: "16px 24px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
            <SearchIcon size={18} />
            记忆搜索
          </h2>
          <span className="text-sm text-muted">
            跨天搜索所有工作记忆，按时间串联呈现同一主题
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="search-input-wrapper" style={{ flex: 1, maxWidth: 500 }}>
            <span className="search-icon">
              <SearchIcon size={15} />
            </span>
            <input
              className="search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索关键词：项目名、应用、内容..."
              style={{ padding: "8px 12px 8px 34px", fontSize: 14 }}
              autoFocus
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                style={{
                  position: "absolute",
                  right: 8,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--color-text-muted)",
                  padding: 4,
                }}
              >
                <XIcon size={14} />
              </button>
            )}
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={groupByDate}
              onChange={(e) => setGroupByDate(e.target.checked)}
            />
            按日期串联
          </label>
        </div>

        {searched && (
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 8 }}>
            {searching ? "搜索中..." : `找到 ${results.length} 条结果`}
            {groupByDate && results.length > 0 && `，分布在 ${groupedResults?.length} 天`}
          </div>
        )}
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
        {!searched ? (
          <div className="empty-state" style={{ flex: 1 }}>
            <div className="empty-state-icon" style={{ fontSize: 48 }}>🔍</div>
            <div className="empty-state-title">搜索你的工作记忆</div>
            <div className="empty-state-desc">
              输入关键词，跨天搜索所有片段。
              <br />
              同一主题在不同时间的记录会按时间线串联呈现。
            </div>
          </div>
        ) : results.length === 0 ? (
          <div className="empty-state" style={{ flex: 1 }}>
            <div className="empty-state-title">未找到匹配结果</div>
            <div className="empty-state-desc">尝试更换关键词</div>
          </div>
        ) : groupByDate && groupedResults ? (
          /* 按日期分组 - 主题串联呈现 */
          <div>
            {groupedResults.map(([date, dayResults]) => {
              const expanded = expandedDates.has(date);
              const totalDuration = dayResults.reduce((sum, r) => sum + r.segment.durationSeconds, 0);
              return (
                <div key={date} style={{ marginBottom: 16 }}>
                  {/* Date header */}
                  <button
                    onClick={() => toggleDate(date)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "10px 14px",
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "var(--radius-md)",
                      cursor: "pointer",
                      marginBottom: expanded ? 8 : 0,
                    }}
                  >
                    {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{date}</span>
                    <span className="tag" style={{ fontSize: 10 }}>
                      {dayResults.length} 条
                    </span>
                    <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginLeft: "auto" }}>
                      <ClockIcon size={11} /> {formatDuration(totalDuration)}
                    </span>
                  </button>

                  {/* Segments for this date */}
                  {expanded && (
                    <div style={{ marginLeft: 12, borderLeft: "2px solid var(--color-border-light)", paddingLeft: 12 }}>
                      {dayResults.map((r) => (
                        <SearchResultCard
                          key={r.segment.id}
                          result={r}
                          query={query}
                          onView={() => handleViewSegment(r.segment)}
                          highlightText={highlightText}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* 平铺列表 */
          <div>
            {results.map((r) => (
              <SearchResultCard
                key={r.segment.id}
                result={r}
                query={query}
                onView={() => handleViewSegment(r.segment)}
                highlightText={highlightText}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface SearchResultCardProps {
  result: SegmentSearchResult;
  query: string;
  onView: () => void;
  highlightText: (text: string, keyword: string) => React.ReactNode;
}

function SearchResultCard({ result, query, onView, highlightText }: SearchResultCardProps) {
  const { segment, matchedFields, snippet } = result;
  const start = segment.startTime.split("T")[1]?.substring(0, 5) || "";
  const end = segment.endTime.split("T")[1]?.substring(0, 5) || "";
  const dur = Math.round(segment.durationSeconds / 60);

  return (
    <div
      className="segment-card"
      style={{ marginBottom: 8, cursor: "pointer" }}
      onClick={onView}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
          {segment.date} {start}-{end}
        </span>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>· {dur}分</span>
        {matchedFields.map((f) => (
          <span
            key={f}
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 10,
              background: "var(--color-warning-light)",
              color: "#d97706",
            }}
          >
            {f}
          </span>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        <span className="app-badge" style={{ fontSize: 10 }}>{segment.appName}</span>
      </div>

      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
        {highlightText(segment.userTitle || segment.windowTitle, query)}
      </div>

      {snippet && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          {highlightText(snippet, query)}
        </div>
      )}
    </div>
  );
}
