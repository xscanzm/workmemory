import React, { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import { useConfirm } from "../components/ConfirmDialog";
import type { ReportTemplate } from "../../shared/types";
import { PlusIcon, EditIcon, TrashIcon, XIcon } from "../components/Icons";

const api = window.workmemory;

export function TemplateCenter() {
  const { templates, setTemplates, showToast } = useAppStore();
  const confirm = useConfirm();
  const [editingTemplate, setEditingTemplate] = useState<ReportTemplate | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    type: "daily" as ReportTemplate["type"],
    prompt: "",
    outputFormat: "rich_text" as "rich_text" | "markdown",
  });

  useEffect(() => {
    api.getTemplates().then(setTemplates);
  }, []);

  const handleSaveNew = async () => {
    if (!form.name.trim() || !form.prompt.trim()) {
      showToast("名称和 Prompt 不能为空", "error");
      return;
    }

    const saved = await api.saveTemplate({
      ...form,
      isBuiltIn: false,
    });
    setTemplates([...templates, saved]);
    setShowNew(false);
    resetForm();
    showToast("模板已保存", "success");
  };

  const handleDelete = async (id: string) => {
    const tmpl = templates.find((t) => t.id === id);
    if (tmpl?.isBuiltIn) {
      showToast("不能删除内置模板", "error");
      return;
    }
    const ok = await confirm({
      title: "删除模板",
      message: `确定删除模板「${tmpl?.name}」？`,
      confirmText: "删除",
      danger: true,
    });
    if (ok) {
      await api.deleteTemplate(id);
      setTemplates(templates.filter((t) => t.id !== id));
      showToast("模板已删除", "success");
    }
  };

  const resetForm = () => {
    setForm({
      name: "",
      description: "",
      type: "daily",
      prompt: "",
      outputFormat: "rich_text",
    });
  };

  const handleEdit = (template: ReportTemplate) => {
    setEditingTemplate(template);
    setForm({
      name: template.name,
      description: template.description,
      type: template.type,
      prompt: template.prompt,
      outputFormat: template.outputFormat,
    });
  };

  return (
    <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
      <div style={{ maxWidth: 800, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 20,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>模板中心</h2>
          <button
            className="btn btn-primary"
            onClick={() => {
              setShowNew(true);
              setEditingTemplate(null);
              resetForm();
            }}
          >
            <PlusIcon size={14} />
            新建模板
          </button>
        </div>

        {/* Template List */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {templates.map((template) => (
            <div key={template.id} className="card card-hover">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{template.name}</span>
                    {template.isBuiltIn && (
                      <span
                        style={{
                          fontSize: 11,
                          padding: "1px 8px",
                          borderRadius: 10,
                          background: "var(--color-bg)",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        内置
                      </span>
                    )}
                    <span
                      style={{
                        fontSize: 11,
                        padding: "1px 8px",
                        borderRadius: 10,
                        background: "var(--color-primary-light)",
                        color: "var(--color-primary)",
                      }}
                    >
                      {template.type === "daily"
                        ? "日报"
                        : template.type === "weekly"
                        ? "周报"
                        : template.type === "review"
                        ? "复盘"
                        : "自定义"}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 8 }}>
                    {template.description}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--color-text-muted)",
                      background: "var(--color-bg)",
                      padding: "8px 12px",
                      borderRadius: "var(--radius-sm)",
                      fontFamily: "var(--font-mono)",
                      maxHeight: 80,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {template.prompt.length > 200
                      ? template.prompt.substring(0, 200) + "..."
                      : template.prompt}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0, marginLeft: 12 }}>
                  <button className="btn btn-sm btn-ghost btn-icon" onClick={() => handleEdit(template)} title="编辑">
                    <EditIcon size={14} />
                  </button>
                  {!template.isBuiltIn && (
                    <button className="btn btn-sm btn-ghost btn-icon" onClick={() => handleDelete(template.id)} title="删除">
                      <TrashIcon size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* New/Edit Modal */}
        {(showNew || editingTemplate) && (
          <div className="modal-overlay" onClick={() => { setShowNew(false); setEditingTemplate(null); }}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">
                  {editingTemplate ? "编辑模板" : "新建模板"}
                </span>
                <button
                  className="btn btn-ghost btn-sm btn-icon"
                  onClick={() => {
                    setShowNew(false);
                    setEditingTemplate(null);
                  }}
                >
                  <XIcon size={14} />
                </button>
              </div>
              <div className="modal-body">
                <div className="form-group">
                  <div className="form-label">名称</div>
                  <input
                    className="form-input"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="模板名称"
                  />
                </div>
                <div className="form-group">
                  <div className="form-label">描述</div>
                  <input
                    className="form-input"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="模板描述"
                  />
                </div>
                <div className="form-group">
                  <div className="form-label">类型</div>
                  <select
                    className="form-input"
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value as any })}
                  >
                    <option value="daily">日报</option>
                    <option value="weekly">周报</option>
                    <option value="review">复盘</option>
                    <option value="custom">自定义</option>
                  </select>
                </div>
                <div className="form-group">
                  <div className="form-label">Prompt</div>
                  <textarea
                    className="form-textarea"
                    value={form.prompt}
                    onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                    placeholder="输入 Prompt，支持变量：{{date}} {{selected_segments}} {{user_notes}}"
                    rows={12}
                    style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                  />
                </div>
                <div className="form-group">
                  <div className="form-label">输出格式</div>
                  <select
                    className="form-input"
                    value={form.outputFormat}
                    onChange={(e) => setForm({ ...form, outputFormat: e.target.value as any })}
                  >
                    <option value="rich_text">富文本</option>
                    <option value="markdown">Markdown</option>
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  className="btn"
                  onClick={() => {
                    setShowNew(false);
                    setEditingTemplate(null);
                  }}
                >
                  取消
                </button>
                <button className="btn btn-primary" onClick={handleSaveNew}>
                  保存
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}