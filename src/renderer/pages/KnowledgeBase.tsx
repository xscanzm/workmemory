import React, { useEffect, useState, useRef, useMemo } from "react";
import { useAppStore } from "../stores/app-store";
import { useConfirm } from "../components/ConfirmDialog";
import type { KnowledgeNode, KnowledgeGraphData } from "../../shared/types";
import {
  BookIcon,
  SearchIcon,
  PlusIcon,
  TrashIcon,
  SaveIcon,
  LinkIcon,
  NetworkIcon,
  RefreshIcon,
  SparklesIcon,
} from "../components/Icons";

const api = window.workmemory;

export function KnowledgeBase() {
  const { showToast } = useAppStore();
  const confirm = useConfirm();
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [selectedNode, setSelectedNode] = useState<KnowledgeNode | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [showGraph, setShowGraph] = useState(false);
  const [graphData, setGraphData] = useState<KnowledgeGraphData | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadNodes();
  }, []);

  const loadNodes = async () => {
    setLoading(true);
    try {
      const data = await api.wikiGetNodes();
      setNodes(data);
    } catch (error) {
      console.error("加载知识库失败:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    setLoading(true);
    try {
      const data = searchQuery.trim()
        ? await api.wikiSearch(searchQuery)
        : await api.wikiGetNodes();
      setNodes(data);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectNode = async (node: KnowledgeNode) => {
    setSelectedNode(node);
    setEditing(false);
    setEditTitle(node.title);
    setEditContent(node.content);
    setEditTags(node.tags.join(", "));
  };

  const handleNewNode = () => {
    setSelectedNode(null);
    setEditing(true);
    setEditTitle("");
    setEditContent("");
    setEditTags("");
  };

  const handleSave = async () => {
    if (!editTitle.trim()) {
      showToast("请输入标题", "error");
      return;
    }
    setSaving(true);
    try {
      const tags = editTags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
      const saved = await api.wikiSaveNode({
        id: selectedNode?.id,
        title: editTitle.trim(),
        content: editContent,
        tags,
        source: selectedNode?.source || "manual",
      });
      setSelectedNode(saved);
      setEditing(false);
      await loadNodes();
      showToast(selectedNode ? "知识点已更新" : "知识点已创建", "success");
    } catch (error) {
      showToast("保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedNode) return;
    const ok = await confirm({
      title: "删除知识点",
      message: `确定删除「${selectedNode.title}」？此操作不可恢复。`,
      confirmText: "删除",
      danger: true,
    });
    if (ok) {
      await api.wikiDeleteNode(selectedNode.id);
      setSelectedNode(null);
      await loadNodes();
      showToast("知识点已删除", "success");
    }
  };

  const handleShowGraph = async () => {
    if (!showGraph) {
      const data = await api.wikiGetGraph();
      setGraphData(data);
    }
    setShowGraph(!showGraph);
  };

  // 渲染双链内容
  const renderedContent = useMemo(() => {
    if (!selectedNode) return "";
    return renderDoubleLinks(editing ? editContent : selectedNode.content, nodes);
  }, [selectedNode, editContent, editing, nodes]);

  return (
    <div className="wiki-layout">
      {/* Sidebar */}
      <div className="wiki-sidebar">
        <div style={{ padding: 12, borderBottom: "1px solid var(--color-border)", display: "flex", gap: 6 }}>
          <button className="btn btn-sm btn-primary" onClick={handleNewNode} style={{ flex: 1 }}>
            <PlusIcon size={14} />
            新建
          </button>
          <button className="btn btn-sm" onClick={handleShowGraph} title="知识图谱">
            <NetworkIcon size={14} />
          </button>
          <button className="btn btn-sm" onClick={loadNodes} title="刷新">
            <RefreshIcon size={14} className={loading ? "spin" : ""} />
          </button>
        </div>

        <div className="wiki-search-box">
          <div style={{ position: "relative" }}>
            <input
              className="form-input"
              style={{ paddingLeft: 30, width: "100%" }}
              placeholder="搜索知识点..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <SearchIcon size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
          </div>
        </div>

        <div className="wiki-node-list">
          {loading ? (
            <div style={{ textAlign: "center", padding: 20, color: "var(--color-text-muted)", fontSize: 13 }}>
              加载中...
            </div>
          ) : nodes.length === 0 ? (
            <div style={{ textAlign: "center", padding: 20, color: "var(--color-text-muted)", fontSize: 13 }}>
              暂无知识点
            </div>
          ) : (
            nodes.map((node) => (
              <div
                key={node.id}
                className={`wiki-node-item ${selectedNode?.id === node.id ? "active" : ""}`}
                onClick={() => handleSelectNode(node)}
              >
                <div className="title">{node.title}</div>
                <div className="meta">
                  {node.tags.slice(0, 3).join(" · ")}
                  {node.linkedNodeIds && node.linkedNodeIds.length > 0 && ` · ${node.linkedNodeIds.length} 链接`}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor / Viewer */}
      <div className="wiki-editor">
        {showGraph && graphData ? (
          <KnowledgeGraphView data={graphData} onClose={() => setShowGraph(false)} onNodeClick={handleSelectNode} allNodes={nodes} />
        ) : editing || !selectedNode ? (
          <EditorView
            title={editTitle}
            content={editContent}
            tags={editTags}
            isNew={!selectedNode}
            saving={saving}
            onTitleChange={setEditTitle}
            onContentChange={setEditContent}
            onTagsChange={setEditTags}
            onSave={handleSave}
            onCancel={() => {
              if (selectedNode) {
                setEditing(false);
                setEditTitle(selectedNode.title);
                setEditContent(selectedNode.content);
                setEditTags(selectedNode.tags.join(", "));
              } else {
                setEditing(false);
              }
            }}
          />
        ) : selectedNode ? (
          <NodeView
            node={selectedNode}
            renderedContent={renderedContent}
            onEdit={() => setEditing(true)}
            onDelete={handleDelete}
            onWikiLinkClick={(title) => {
              const target = nodes.find((n) => n.title === title);
              if (target) handleSelectNode(target);
              else {
                setEditing(true);
                setSelectedNode(null);
                setEditTitle(title);
                setEditContent("");
                setEditTags("");
              }
            }}
          />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

// === Editor View ===
function EditorView({
  title,
  content,
  tags,
  isNew,
  saving,
  onTitleChange,
  onContentChange,
  onTagsChange,
  onSave,
  onCancel,
}: {
  title: string;
  content: string;
  tags: string;
  isNew: boolean;
  saving: boolean;
  onTitleChange: (v: string) => void;
  onContentChange: (v: string) => void;
  onTagsChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="wiki-editor-header">
        <input
          className="wiki-editor-title"
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="知识点标题..."
        />
        <button className="btn btn-sm btn-primary" onClick={onSave} disabled={saving}>
          <SaveIcon size={14} />
          {saving ? "保存中..." : "保存"}
        </button>
        <button className="btn btn-sm" onClick={onCancel}>
          取消
        </button>
      </div>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--color-border)" }}>
        <input
          className="form-input"
          style={{ width: "100%" }}
          value={tags}
          onChange={(e) => onTagsChange(e.target.value)}
          placeholder="标签（逗号分隔）..."
        />
      </div>
      <textarea
        className="wiki-editor-content"
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        placeholder={`输入知识点内容...\n\n支持 Markdown 格式\n使用 [[标题]] 创建双链，例如：[[React性能优化]]`}
        style={{
          border: "none",
          resize: "none",
          fontFamily: "inherit",
          background: "var(--color-surface)",
        }}
      />
      <div style={{ padding: "8px 16px", borderTop: "1px solid var(--color-border)", fontSize: 12, color: "var(--color-text-muted)" }}>
        {isNew ? "新建知识点" : "编辑模式"} · 使用 [[标题]] 创建双链 · 支持 Markdown
      </div>
    </>
  );
}

// === Node View ===
function NodeView({
  node,
  renderedContent,
  onEdit,
  onDelete,
  onWikiLinkClick,
}: {
  node: KnowledgeNode;
  renderedContent: string;
  onEdit: () => void;
  onDelete: () => void;
  onWikiLinkClick: (title: string) => void;
}) {
  return (
    <>
      <div className="wiki-editor-header">
        <span className="wiki-editor-title">{node.title}</span>
        <button className="btn btn-sm" onClick={onEdit}>
          编辑
        </button>
        <button className="btn btn-sm btn-danger" onClick={onDelete}>
          <TrashIcon size={14} />
          删除
        </button>
      </div>
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--color-border)", display: "flex", gap: 6, flexWrap: "wrap" }}>
        {node.tags.map((tag) => (
          <span key={tag} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "var(--color-bg)", color: "var(--color-text-secondary)" }}>
            {tag}
          </span>
        ))}
        {node.source === "extracted" && (
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "var(--color-primary-light)", color: "var(--color-primary)" }}>
            <SparklesIcon size={10} style={{ display: "inline", marginRight: 2 }} />
            AI提取
          </span>
        )}
        {node.linkedNodeIds && node.linkedNodeIds.length > 0 && (
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "var(--color-success-light)", color: "var(--color-success)" }}>
            <LinkIcon size={10} style={{ display: "inline", marginRight: 2 }} />
            {node.linkedNodeIds.length} 双链
          </span>
        )}
      </div>
      <div
        className="wiki-editor-content"
        dangerouslySetInnerHTML={{
          __html: renderedContent
            .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:600;margin:16px 0 8px;">$1</h2>')
            .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:600;margin:12px 0 6px;">$1</h3>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/^- (.+)$/gm, '<li style="margin-left:20px;">$1</li>')
            .replace(/\n/g, "<br/>"),
        }}
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.classList.contains("wiki-link") || target.classList.contains("wiki-link-missing")) {
            const title = target.getAttribute("data-wiki-title");
            if (title) onWikiLinkClick(title);
          }
        }}
      />
    </>
  );
}

// === Knowledge Graph View ===
function KnowledgeGraphView({
  data,
  onClose,
  onNodeClick,
  allNodes,
}: {
  data: KnowledgeGraphData;
  onClose: () => void;
  onNodeClick: (node: KnowledgeNode) => void;
  allNodes: KnowledgeNode[];
}) {
  const width = 800;
  const height = 400;
  const centerX = width / 2;
  const centerY = height / 2;

  // 简单圆形布局
  const nodePositions = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    const n = data.nodes.length;
    if (n === 0) return positions;
    const radius = Math.min(width, height) / 3;
    data.nodes.forEach((node, i) => {
      const angle = (i / n) * Math.PI * 2;
      positions.set(node.id, {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
      });
    });
    return positions;
  }, [data.nodes]);

  return (
    <>
      <div className="wiki-editor-header">
        <span className="wiki-editor-title">
          <NetworkIcon size={16} style={{ display: "inline", marginRight: 6 }} />
          知识图谱
        </span>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
          {data.nodes.length} 节点 · {data.edges.length} 连接
        </span>
        <button className="btn btn-sm" onClick={onClose}>
          关闭
        </button>
      </div>
      <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
        <svg className="wiki-graph-canvas" viewBox={`0 0 ${width} ${height}`}>
          {/* Edges */}
          {data.edges.map((edge, i) => {
            const source = nodePositions.get(edge.source);
            const target = nodePositions.get(edge.target);
            if (!source || !target) return null;
            return (
              <line
                key={i}
                className="graph-edge-line"
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
              />
            );
          })}
          {/* Nodes */}
          {data.nodes.map((node) => {
            const pos = nodePositions.get(node.id);
            if (!pos) return null;
            const r = 12 + Math.min(node.linkCount * 3, 12);
            const color = node.linkCount > 0 ? "#3b82f6" : "#9ca3af";
            const fullNode = allNodes.find((n) => n.id === node.id);
            return (
              <g key={node.id} onClick={() => fullNode && onNodeClick(fullNode)} style={{ cursor: "pointer" }}>
                <circle
                  className="graph-node-circle"
                  cx={pos.x}
                  cy={pos.y}
                  r={r}
                  fill={color}
                  opacity={0.8}
                />
                <text
                  className="graph-node-label"
                  x={pos.x}
                  y={pos.y + r + 14}
                >
                  {node.title.length > 8 ? node.title.substring(0, 8) + "..." : node.title}
                </text>
              </g>
            );
          })}
        </svg>
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--color-text-muted)" }}>
          节点大小表示连接数 · 点击节点查看详情 · 蓝色节点有双链连接
        </div>
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", color: "var(--color-text-muted)" }}>
      <BookIcon size={48} style={{ opacity: 0.3, marginBottom: 16 }} />
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>选择或创建一个知识点</div>
      <div style={{ fontSize: 12 }}>使用 [[标题]] 语法创建双链，构建你的知识网络</div>
    </div>
  );
}

// === Helper: Render Double Links ===
function renderDoubleLinks(content: string, existingNodes: KnowledgeNode[]): string {
  const existingTitles = existingNodes.map((n) => n.title);
  return content.replace(/\[\[([^\]]+)\]\]/g, (match, title) => {
    const trimmed = title.trim();
    const exists = existingTitles.includes(trimmed);
    const cls = exists ? "wiki-link" : "wiki-link-missing";
    return `<a class="${cls}" data-wiki-title="${trimmed}" href="#">${trimmed}</a>`;
  });
}
