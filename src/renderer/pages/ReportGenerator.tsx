import React, { useEffect, useState, useMemo, useRef } from "react";
import { useAppStore } from "../stores/app-store";
import type { ReportTemplate, Report } from "../../shared/types";
import {
  BoldIcon,
  HeadingIcon,
  ListIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  RefreshIcon,
  HistoryIcon,
  SparklesIcon,
  CheckIcon,
  XIcon,
} from "../components/Icons";

const api = window.workmemory;

export function ReportGenerator() {
  const { segments, showToast, templates, setTemplates } = useAppStore();
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const [generating, setGenerating] = useState(false);
  const [markdownContent, setMarkdownContent] = useState("");
  const [htmlContent, setHtmlContent] = useState("");
  const [error, setError] = useState("");
  const [reportId, setReportId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [historyReports, setHistoryReports] = useState<Report[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);

  const today = new Date().toISOString().split("T")[0];
  const selectedSegments = segments.filter((s) => s.isSelectedForReport);

  useEffect(() => {
    api.getTemplates().then((data) => {
      setTemplates(data);
      if (data.length > 0) {
        setSelectedTemplateId(data[0].id);
      }
    });
    loadHistory();
  }, []);

  const loadHistory = async () => {
    const reports = await api.getReports();
    setHistoryReports(reports);
  };

  // 字数统计
  const wordCount = useMemo(() => {
    if (!markdownContent) return 0;
    // 去除 markdown 标记后统计
    const text = markdownContent
      .replace(/[#*`>\-_~\[\]\(\)]/g, "")
      .replace(/\n/g, "")
      .trim();
    return text.length;
  }, [markdownContent]);

  const readTime = useMemo(() => {
    return Math.max(1, Math.ceil(wordCount / 300));
  }, [wordCount]);

  // 生成前确认
  const handleGenerateClick = () => {
    if (!selectedTemplateId) {
      showToast("请先选择模板", "error");
      return;
    }
    if (selectedSegments.length === 0) {
      showToast("请先在今日记忆轴中勾选要参与生成的片段", "error");
      return;
    }
    setConfirming(true);
  };

  const handleGenerate = async () => {
    setConfirming(false);
    setGenerating(true);
    setError("");
    setMarkdownContent("");
    setHtmlContent("");
    setReportId(null);

    try {
      const result = await api.generateReport({
        date: today,
        templateId: selectedTemplateId,
        userNotes: userNotes || undefined,
      });

      if (result.error) {
        setError(result.error);
        showToast(result.error, "error");
      } else if (result.content) {
        setMarkdownContent(result.content);
        setReportId(result.reportId || null);
        const html = await api.copyRichText(result.content);
        setHtmlContent(html);
        showToast("日报生成成功，已自动保存", "success");
        loadHistory();
      }
    } catch (err: any) {
      setError(err?.message || "生成失败");
      showToast("生成失败", "error");
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveReport = async () => {
    if (!reportId) return;
    await api.saveReport({
      id: reportId,
      markdownContent,
      richTextContent: htmlContent,
      status: "edited",
    });
    showToast("日报已保存", "success");
    loadHistory();
  };

  const handleExportMarkdown = async () => {
    const filename = `日报_${today}.md`;
    const result = await api.exportMarkdown(markdownContent, filename);
    if (result.success) {
      showToast("Markdown 导出成功", "success");
    } else if (result.error !== "已取消") {
      showToast(result.error || "导出失败", "error");
    }
  };

  const handleExportWord = async () => {
    const filename = `日报_${today}.doc`;
    const result = await api.exportWord(htmlContent, filename);
    if (result.success) {
      showToast("Word 导出成功", "success");
    } else if (result.error !== "已取消") {
      showToast(result.error || "导出失败", "error");
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([htmlContent], { type: "text/html" }),
          "text/plain": new Blob([markdownContent], { type: "text/plain" }),
        }),
      ]);
      showToast("已复制到剪贴板", "success");
    } catch {
      await navigator.clipboard.writeText(markdownContent);
      showToast("已复制（纯文本）", "success");
    }
  };

  // 编辑器格式化命令
  const execCommand = (command: string, value?: string) => {
    document.execCommand(command, false, value);
    if (editorRef.current) {
      setHtmlContent(editorRef.current.innerHTML);
    }
  };

  // 加载历史日报
  const handleLoadHistory = (report: Report) => {
    setMarkdownContent(report.markdownContent || "");
    setHtmlContent(report.richTextContent || "");
    setReportId(report.id);
    setShowHistory(false);
    showToast("已加载历史日报", "info");
  };

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Left: Configuration */}
      <div
        style={{
          width: 360,
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid var(--color-border)",
          overflow: "auto",
          flexShrink: 0,
        }}
      >
        <div style={{ padding: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <SparklesIcon size={18} />
            生成日报
          </h2>

          {/* Date */}
          <div className="form-group">
            <div className="form-label">日期</div>
            <div className="form-input" style={{ background: "var(--color-bg)" }}>
              {today}
            </div>
          </div>

          {/* Template */}
          <div className="form-group">
            <div className="form-label">选择模板</div>
            <select
              className="form-input"
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} {t.isBuiltIn ? "(内置)" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Selected segments preview */}
          <div className="form-group">
            <div className="form-label">
              参与生成的片段 ({selectedSegments.length})
            </div>
            <div
              style={{
                maxHeight: 160,
                overflow: "auto",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
              }}
            >
              {selectedSegments.length === 0 ? (
                <div className="text-sm text-muted" style={{ padding: 12 }}>
                  请先在今日记忆轴中勾选片段
                </div>
              ) : (
                selectedSegments.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      padding: "6px 10px",
                      fontSize: 12,
                      borderBottom: "1px solid var(--color-border-light)",
                    }}
                  >
                    <span style={{ color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                      {s.startTime.split("T")[1]?.substring(0, 5)}
                    </span>{" "}
                    <span className="app-badge" style={{ fontSize: 10 }}>{s.appName}</span>
                    <div className="truncate" style={{ marginTop: 2 }}>
                      {s.userTitle || s.windowTitle}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* User Notes */}
          <div className="form-group">
            <div className="form-label">补充说明（可选）</div>
            <textarea
              className="form-textarea"
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              placeholder="今天的工作重点、额外说明..."
              rows={3}
            />
          </div>

          {/* Generate Button */}
          <button
            className="btn btn-primary"
            onClick={handleGenerateClick}
            disabled={generating || selectedSegments.length === 0}
            style={{ width: "100%", justifyContent: "center", padding: "10px 0" }}
          >
            {generating ? (
              <>
                <RefreshIcon size={14} className="spin" />
                生成中...
              </>
            ) : (
              <>
                <SparklesIcon size={14} />
                生成日报
              </>
            )}
          </button>

          {/* 确认对话框 */}
          {confirming && (
            <div
              style={{
                marginTop: 12,
                padding: 16,
                borderRadius: "var(--radius-md)",
                background: "var(--color-primary-light)",
                border: "1px solid var(--color-primary)",
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 8 }}>确认生成日报</div>
              <div style={{ color: "var(--color-text-secondary)", lineHeight: 1.8, marginBottom: 12 }}>
                将发送 {selectedSegments.length} 个片段的结构化文本给 AI 服务。
                <br />
                不会发送截图，仅发送勾选片段的标题、摘要和备注。
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleGenerate}
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  确认生成
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => setConfirming(false)}
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                borderRadius: "var(--radius-sm)",
                background: "var(--color-danger-light)",
                color: "var(--color-danger)",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          {/* History */}
          <div style={{ marginTop: 20 }}>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setShowHistory(!showHistory)}
              style={{ width: "100%", justifyContent: "flex-start" }}
            >
              <HistoryIcon size={14} />
              历史日报 ({historyReports.length})
            </button>
            {showHistory && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {historyReports.length === 0 ? (
                  <div className="text-sm text-muted" style={{ padding: 8 }}>
                    暂无历史日报
                  </div>
                ) : (
                  historyReports.slice(0, 10).map((r) => (
                    <button
                      key={r.id}
                      className="btn btn-sm btn-ghost"
                      onClick={() => handleLoadHistory(r)}
                      style={{ justifyContent: "flex-start", textAlign: "left" }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="truncate" style={{ fontSize: 12, fontWeight: 500 }}>
                          {r.templateName || "日报"}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--color-text-muted)" }}>
                          {r.date} · {r.status === "edited" ? "已编辑" : "已生成"}
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right: Editor */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 16px",
            borderBottom: "1px solid var(--color-border)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>日报预览</span>
          {markdownContent && (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--color-text-muted)", marginRight: 8 }}>
                {wordCount} 字 · 约 {readTime} 分钟
              </span>
              <button className="btn btn-sm" onClick={handleSaveReport} disabled={!reportId} title="保存">
                <CheckIcon size={13} />
                保存
              </button>
              <button className="btn btn-sm btn-ghost btn-icon" onClick={handleCopy} title="复制">
                <CopyIcon size={14} />
              </button>
              <button className="btn btn-sm btn-ghost btn-icon" onClick={handleExportMarkdown} title="导出 Markdown">
                <DownloadIcon size={14} />
              </button>
              <button className="btn btn-sm btn-ghost btn-icon" onClick={handleExportWord} title="导出 Word">
                <DownloadIcon size={14} />
              </button>
              <button className="btn btn-sm btn-ghost btn-icon" onClick={handleGenerateClick} title="重新生成">
                <RefreshIcon size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Editor Toolbar */}
        {markdownContent && (
          <div className="editor-toolbar">
            <button
              className="editor-toolbar-btn"
              onClick={() => execCommand("bold")}
              title="加粗 (Ctrl+B)"
            >
              <BoldIcon size={14} />
            </button>
            <button
              className="editor-toolbar-btn"
              onClick={() => execCommand("formatBlock", "h2")}
              title="标题"
            >
              <HeadingIcon size={14} />
            </button>
            <div className="editor-toolbar-divider" />
            <button
              className="editor-toolbar-btn"
              onClick={() => execCommand("insertUnorderedList")}
              title="无序列表"
            >
              <ListIcon size={14} />
            </button>
            <button
              className="editor-toolbar-btn"
              onClick={() => execCommand("insertOrderedList")}
              title="有序列表"
            >
              <ListIcon size={14} />
            </button>
            <div className="editor-toolbar-divider" />
            <button
              className="editor-toolbar-btn"
              onClick={() => execCommand("formatBlock", "blockquote")}
              title="引用"
            >
              <CodeIcon size={14} />
            </button>
            <button
              className="editor-toolbar-btn"
              onClick={() => execCommand("formatBlock", "pre")}
              title="代码块"
            >
              <CodeIcon size={14} />
            </button>
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {markdownContent ? (
            <div
              ref={editorRef}
              className="rich-text-editor"
              contentEditable
              suppressContentEditableWarning
              dangerouslySetInnerHTML={{ __html: htmlContent }}
              onInput={(e) => {
                setHtmlContent(e.currentTarget.innerHTML);
              }}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-state-icon" style={{ fontSize: 56 }}>📝</div>
              <div className="empty-state-title">选择模板并生成日报</div>
              <div className="empty-state-desc">
                在左侧选择模板，确认参与生成的片段，然后点击「生成日报」。
                <br />
                生成后可在此编辑、导出。
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
