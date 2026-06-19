import React, { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import { useConfirm } from "../components/ConfirmDialog";
import type { AppConfig, PrivacyRule, AiProviderConfig, PetCharacter } from "../../shared/types";
import { PET_CHARACTERS, PET_CHARACTER_LABELS } from "../../shared/types";
import {
  ClockIcon,
  EyeIcon,
  SparklesIcon,
  ShieldIcon,
  TrashIcon,
  InfoIcon,
  CheckIcon,
  XIcon,
  RefreshIcon,
  UsersIcon,
  BellIcon,
} from "../components/Icons";

const api = window.workmemory;

export function Settings() {
  const {
    appConfig,
    setAppConfig,
    privacyRules,
    setPrivacyRules,
    aiConfigs,
    setAiConfigs,
    showToast,
  } = useAppStore();
  const confirm = useConfirm();

  const [activeTab, setActiveTab] = useState<
    "recording" | "ocr" | "ai" | "privacy" | "pet" | "intelligence" | "data" | "about"
  >("recording");

  const [configForm, setConfigForm] = useState<Partial<AppConfig>>({});
  const [configDirty, setConfigDirty] = useState(false);
  const [newPrivacyPattern, setNewPrivacyPattern] = useState("");
  const [newPrivacyType, setNewPrivacyType] =
    useState<PrivacyRule["type"]>("window_title");
  const [aiConfigForm, setAiConfigForm] = useState({
    name: "",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEncrypted: "",
    model: "gpt-4.1-mini",
    temperature: 0.3,
    maxTokens: 4096,
    timeoutSeconds: 60,
    stream: true,
    providerType: "openai_compatible" as const,
  });
  const [testingAi, setTestingAi] = useState(false);
  const [petConfig, setPetConfig] = useState<{ enabled: boolean; character: PetCharacter }>({
    enabled: true,
    character: "cat",
  });

  useEffect(() => {
    api.getAppConfig().then((config) => {
      setAppConfig(config);
      setConfigForm(config);
    });
    api.getPrivacyRules().then(setPrivacyRules);
    api.getAiConfigs().then(setAiConfigs);
    api.getPetConfig().then((cfg) => setPetConfig(cfg));
  }, []);

  // 即时保存配置（change 即存）
  const updateConfig = async (updates: Partial<AppConfig>) => {
    const newConfig = { ...configForm, ...updates };
    setConfigForm(newConfig);
    setConfigDirty(true);
    // 防抖保存
    setTimeout(async () => {
      await api.saveAppConfig(newConfig);
      setConfigDirty(false);
    }, 500);
  };

  // Pet 配置切换
  const handlePetEnabledChange = async (enabled: boolean) => {
    const result = await api.setPetEnabled(enabled);
    setPetConfig(result);
    showToast(enabled ? "桌面形象已开启" : "桌面形象已关闭", "success");
  };

  const handlePetCharacterChange = async (character: PetCharacter) => {
    const result = await api.setPetCharacter(character);
    setPetConfig(result);
    showToast(`已切换为${PET_CHARACTER_LABELS[character]}`, "success");
  };

  // ===== Privacy Settings =====
  const handleAddPrivacyRule = async () => {
    if (!newPrivacyPattern.trim()) return;
    const rule = await api.savePrivacyRule({
      type: newPrivacyType,
      pattern: newPrivacyPattern.trim(),
      matchMode: "contains",
      enabled: true,
    });
    setPrivacyRules([...privacyRules, rule]);
    setNewPrivacyPattern("");
    showToast("隐私规则已添加", "success");
  };

  const handleDeletePrivacyRule = async (id: string) => {
    const ok = await confirm({
      title: "删除规则",
      message: "确定删除此隐私规则？",
      confirmText: "删除",
      danger: true,
    });
    if (ok) {
      await api.deletePrivacyRule(id);
      setPrivacyRules(privacyRules.filter((r) => r.id !== id));
      showToast("规则已删除", "success");
    }
  };

  const handleTogglePrivacyRule = async (id: string) => {
    const rule = privacyRules.find((r) => r.id === id);
    if (!rule) return;
    const updatedRules = await api.updatePrivacyRule(id, { enabled: !rule.enabled });
    setPrivacyRules(updatedRules);
  };

  // ===== AI Settings =====
  const handleSaveAiConfig = async () => {
    if (!aiConfigForm.name.trim() || !aiConfigForm.apiKeyEncrypted.trim()) {
      showToast("名称和 API Key 不能为空", "error");
      return;
    }

    const saved = await api.saveAiConfig(aiConfigForm);
    setAiConfigs([...aiConfigs, saved]);
    setAiConfigForm({
      name: "",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEncrypted: "",
      model: "gpt-4.1-mini",
      temperature: 0.3,
      maxTokens: 4096,
      timeoutSeconds: 60,
      stream: true,
      providerType: "openai_compatible",
    });
    showToast("AI 配置已保存", "success");
  };

  const handleDeleteAiConfig = async (id: string) => {
    const ok = await confirm({
      title: "删除 AI 配置",
      message: "确定删除此 AI 配置？",
      confirmText: "删除",
      danger: true,
    });
    if (ok) {
      await api.deleteAiConfig(id);
      setAiConfigs(aiConfigs.filter((c) => c.id !== id));
      showToast("配置已删除", "success");
    }
  };

  const handleTestConnection = async (configId?: string) => {
    setTestingAi(true);
    try {
      const result = await api.testAiConnection(configId);
      if (result.success) {
        showToast("连接测试成功", "success");
      } else {
        showToast(result.error || "连接测试失败", "error");
      }
    } catch {
      showToast("连接测试失败", "error");
    } finally {
      setTestingAi(false);
    }
  };

  // ===== Data Settings =====
  const handleClearToday = async () => {
    const ok = await confirm({
      title: "清空今日记录",
      message: "确定清空今天的所有记录？此操作不可恢复。",
      confirmText: "清空",
      danger: true,
    });
    if (ok) {
      const today = new Date().toISOString().split("T")[0];
      await api.clearToday(today);
      showToast("今日记录已清空", "success");
    }
  };

  const handleClearAll = async () => {
    const ok = await confirm({
      title: "清空所有数据",
      message: "确定清空所有历史记录、配置和日报？此操作不可恢复！",
      confirmText: "清空全部",
      danger: true,
    });
    if (ok) {
      await api.clearAll();
      showToast("所有数据已清空", "success");
    }
  };

  const handleClearAiConfigs = async () => {
    const ok = await confirm({
      title: "清空 AI 配置",
      message: "确定删除所有已保存的 AI 配置？",
      confirmText: "清空",
      danger: true,
    });
    if (ok) {
      for (const c of aiConfigs) {
        await api.deleteAiConfig(c.id);
      }
      setAiConfigs([]);
      showToast("所有 AI 配置已删除", "success");
    }
  };

  const tabs = [
    { key: "recording", label: "记录设置", icon: <ClockIcon size={15} /> },
    { key: "ocr", label: "OCR 设置", icon: <EyeIcon size={15} /> },
    { key: "ai", label: "AI 设置", icon: <SparklesIcon size={15} /> },
    { key: "privacy", label: "隐私设置", icon: <ShieldIcon size={15} /> },
    { key: "pet", label: "桌面形象", icon: <UsersIcon size={15} /> },
    { key: "intelligence", label: "主动智能", icon: <BellIcon size={15} /> },
    { key: "data", label: "数据管理", icon: <TrashIcon size={15} /> },
    { key: "about", label: "关于", icon: <InfoIcon size={15} /> },
  ] as const;

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* Sidebar */}
      <div
        style={{
          width: 180,
          borderRight: "1px solid var(--color-border)",
          padding: "12px 8px",
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`nav-tab ${activeTab === tab.key ? "active" : ""}`}
            style={{
              display: "flex",
              width: "100%",
              textAlign: "left",
              borderRadius: "var(--radius-sm)",
              padding: "8px 12px",
              marginBottom: 2,
            }}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 24 }}>
        <div style={{ maxWidth: 600 }}>
          {/* 保存状态指示 */}
          {configDirty && (
            <div
              style={{
                position: "fixed",
                top: 60,
                right: 24,
                fontSize: 12,
                color: "var(--color-text-muted)",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <RefreshIcon size={12} className="spin" />
              保存中...
            </div>
          )}

          {/* Recording Settings */}
          {activeTab === "recording" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
                <ClockIcon size={18} />
                记录设置
              </h2>
              <div className="text-sm text-muted" style={{ marginBottom: 20 }}>
                修改后自动保存
              </div>

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={configForm.launchAtStartup || false}
                    onChange={(e) => updateConfig({ launchAtStartup: e.target.checked })}
                  />
                  开机自启
                </label>
                <div className="text-sm text-muted" style={{ marginLeft: 24, marginTop: 4 }}>
                  开机后自动启动并隐藏在后台，桌面形象会显示
                </div>
              </div>

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={configForm.saveScreenshots || false}
                    onChange={(e) => updateConfig({ saveScreenshots: e.target.checked })}
                  />
                  保存截图（默认不保存，OCR 后删除）
                </label>
              </div>

              <div className="form-group">
                <div className="form-label">最短截图间隔（秒）</div>
                <input
                  className="form-input"
                  type="number"
                  value={configForm.minScreenshotIntervalSeconds || 30}
                  onChange={(e) =>
                    updateConfig({
                      minScreenshotIntervalSeconds: parseInt(e.target.value) || 30,
                    })
                  }
                  min={10}
                  max={300}
                />
              </div>

              <div className="form-group">
                <div className="form-label">最大片段时长（分钟）</div>
                <input
                  className="form-input"
                  type="number"
                  value={configForm.maxSegmentDurationMinutes || 60}
                  onChange={(e) =>
                    updateConfig({
                      maxSegmentDurationMinutes: parseInt(e.target.value) || 60,
                    })
                  }
                  min={10}
                  max={240}
                />
              </div>

              <div className="form-group">
                <div className="form-label">空闲检测阈值（分钟）</div>
                <input
                  className="form-input"
                  type="number"
                  value={configForm.idleThresholdMinutes || 5}
                  onChange={(e) =>
                    updateConfig({
                      idleThresholdMinutes: parseInt(e.target.value) || 5,
                    })
                  }
                  min={1}
                  max={30}
                />
              </div>

              <div className="form-group">
                <div className="form-label">隐私动作</div>
                <select
                  className="form-input"
                  value={configForm.privacyAction || "skip"}
                  onChange={(e) =>
                    updateConfig({
                      privacyAction: e.target.value as "skip" | "placeholder",
                    })
                  }
                >
                  <option value="skip">完全跳过</option>
                  <option value="placeholder">保留隐私占位</option>
                </select>
              </div>
            </div>
          )}

          {/* OCR Settings */}
          {activeTab === "ocr" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
                <EyeIcon size={18} />
                OCR 设置
              </h2>
              <div className="text-sm text-muted" style={{ marginBottom: 20 }}>
                修改后自动保存
              </div>

              <div className="form-group">
                <div className="form-label">OCR 引擎</div>
                <select
                  className="form-input"
                  value={configForm.ocrProvider || "paddleocr"}
                  onChange={(e) =>
                    updateConfig({
                      ocrProvider: e.target.value as any,
                    })
                  }
                >
                  <option value="paddleocr">PaddleOCR</option>
                  <option value="windows_ocr">Windows OCR</option>
                  <option value="mock">Mock（测试用）</option>
                </select>
              </div>

              <div className="form-group">
                <div className="form-label">OCR 语言</div>
                <select
                  className="form-input"
                  value={configForm.ocrLanguage || "ch_en"}
                  onChange={(e) =>
                    updateConfig({
                      ocrLanguage: e.target.value as any,
                    })
                  }
                >
                  <option value="ch">中文</option>
                  <option value="en">英文</option>
                  <option value="ch_en">中英文混合</option>
                </select>
              </div>

              <div style={{ marginTop: 16, padding: 12, background: "var(--color-bg)", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>PaddleOCR 安装说明</div>
                <div style={{ color: "var(--color-text-secondary)", lineHeight: 1.8 }}>
                  首次使用需要安装 PaddleOCR：
                  <br />
                  <code style={{ background: "var(--color-surface)", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}>
                    pip install paddleocr paddlepaddle
                  </code>
                  <br />
                  安装完成后，重启应用即可使用。
                </div>
              </div>
            </div>
          )}

          {/* AI Settings */}
          {activeTab === "ai" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>AI 设置</h2>

              {/* Existing configs */}
              {aiConfigs.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div className="form-label">已配置的 AI 服务</div>
                  {aiConfigs.map((cfg) => (
                    <div key={cfg.id} className="card" style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{cfg.name}</div>
                          <div className="text-sm text-muted">
                            {cfg.baseUrl} · {cfg.model}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="btn btn-sm"
                            onClick={() => handleTestConnection(cfg.id)}
                            disabled={testingAi}
                          >
                            {testingAi ? "测试中..." : "测试连接"}
                          </button>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleDeleteAiConfig(cfg.id)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add new config */}
              <div className="card">
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>
                  添加 AI 配置
                </div>

                <div className="form-group">
                  <div className="form-label">配置名称</div>
                  <input
                    className="form-input"
                    value={aiConfigForm.name}
                    onChange={(e) =>
                      setAiConfigForm({ ...aiConfigForm, name: e.target.value })
                    }
                    placeholder="例如：我的 OpenAI"
                  />
                </div>

                <div className="form-group">
                  <div className="form-label">Base URL</div>
                  <input
                    className="form-input"
                    value={aiConfigForm.baseUrl}
                    onChange={(e) =>
                      setAiConfigForm({ ...aiConfigForm, baseUrl: e.target.value })
                    }
                    placeholder="https://api.openai.com/v1"
                  />
                </div>

                <div className="form-group">
                  <div className="form-label">API Key</div>
                  <input
                    className="form-input"
                    type="password"
                    value={aiConfigForm.apiKeyEncrypted}
                    onChange={(e) =>
                      setAiConfigForm({ ...aiConfigForm, apiKeyEncrypted: e.target.value })
                    }
                    placeholder="sk-..."
                  />
                </div>

                <div className="form-group">
                  <div className="form-label">Model</div>
                  <input
                    className="form-input"
                    value={aiConfigForm.model}
                    onChange={(e) =>
                      setAiConfigForm({ ...aiConfigForm, model: e.target.value })
                    }
                    placeholder="gpt-4.1-mini"
                  />
                </div>

                <div className="form-group">
                  <div className="form-label">Temperature ({aiConfigForm.temperature})</div>
                  <input
                    className="form-input"
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={aiConfigForm.temperature}
                    onChange={(e) =>
                      setAiConfigForm({
                        ...aiConfigForm,
                        temperature: parseFloat(e.target.value),
                      })
                    }
                  />
                </div>

                <div className="form-group">
                  <div className="form-label">Max Tokens</div>
                  <input
                    className="form-input"
                    type="number"
                    value={aiConfigForm.maxTokens}
                    onChange={(e) =>
                      setAiConfigForm({
                        ...aiConfigForm,
                        maxTokens: parseInt(e.target.value) || 4096,
                      })
                    }
                  />
                </div>

                <div className="form-group">
                  <div className="form-label">超时时间（秒）</div>
                  <input
                    className="form-input"
                    type="number"
                    value={aiConfigForm.timeoutSeconds}
                    onChange={(e) =>
                      setAiConfigForm({
                        ...aiConfigForm,
                        timeoutSeconds: parseInt(e.target.value) || 60,
                      })
                    }
                  />
                </div>

                <div className="form-group">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={aiConfigForm.stream}
                      onChange={(e) =>
                        setAiConfigForm({ ...aiConfigForm, stream: e.target.checked })
                      }
                    />
                    流式输出
                  </label>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-primary" onClick={handleSaveAiConfig}>
                    保存配置
                  </button>
                  <button
                    className="btn"
                    onClick={() => handleTestConnection()}
                    disabled={testingAi || !aiConfigForm.apiKeyEncrypted}
                  >
                    {testingAi ? "测试中..." : "测试连接"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Privacy Settings */}
          {activeTab === "privacy" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>隐私设置</h2>

              <div style={{ marginBottom: 20 }}>
                <div className="form-label">
                  隐私黑名单规则
                </div>
                <div className="text-sm text-muted" style={{ marginBottom: 12 }}>
                  命中规则的窗口将不会截图和 OCR，根据设置跳过或保留隐私占位。
                </div>

                {/* Add rule */}
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <select
                    className="form-input"
                    style={{ width: 140 }}
                    value={newPrivacyType}
                    onChange={(e) =>
                      setNewPrivacyType(e.target.value as PrivacyRule["type"])
                    }
                  >
                    <option value="window_title">窗口标题</option>
                    <option value="app_name">应用名</option>
                    <option value="process_name">进程名</option>
                  </select>
                  <input
                    className="form-input"
                    style={{ flex: 1 }}
                    value={newPrivacyPattern}
                    onChange={(e) => setNewPrivacyPattern(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddPrivacyRule();
                    }}
                    placeholder="输入关键词..."
                  />
                  <button className="btn btn-primary" onClick={handleAddPrivacyRule}>
                    添加
                  </button>
                </div>

                {/* Rule list */}
                {privacyRules.length === 0 ? (
                  <div className="text-sm text-muted">暂无隐私规则</div>
                ) : (
                  privacyRules.map((rule) => (
                    <div
                      key={rule.id}
                      className="card"
                      style={{
                        marginBottom: 6,
                        opacity: rule.enabled ? 1 : 0.5,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={rule.enabled}
                            onChange={() => handleTogglePrivacyRule(rule.id)}
                          />
                          <span
                            style={{
                              fontSize: 11,
                              padding: "1px 8px",
                              borderRadius: 10,
                              background: "var(--color-bg)",
                              color: "var(--color-text-secondary)",
                            }}
                          >
                            {rule.type === "window_title"
                              ? "标题"
                              : rule.type === "app_name"
                              ? "应用"
                              : "进程"}
                          </span>
                          <span style={{ fontSize: 13 }}>{rule.pattern}</span>
                        </div>
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={() => handleDeletePrivacyRule(rule.id)}
                          title="删除"
                        >
                          <XIcon size={14} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div style={{ padding: 12, background: "var(--color-bg)", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>默认建议黑名单</div>
                <div style={{ color: "var(--color-text-secondary)", lineHeight: 1.8 }}>
                  密码、支付、银行、身份证、医疗、私聊、无痕、password、bank、private、incognito
                </div>
              </div>
            </div>
          )}

          {/* Pet Settings */}
          {activeTab === "pet" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
                <UsersIcon size={18} />
                桌面形象
              </h2>
              <div className="text-sm text-muted" style={{ marginBottom: 20 }}>
                常驻桌面的动态形象，让你知道我在这里
              </div>

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={petConfig.enabled}
                    onChange={(e) => handlePetEnabledChange(e.target.checked)}
                  />
                  显示桌面形象
                </label>
                <div className="text-sm text-muted" style={{ marginLeft: 24, marginTop: 4 }}>
                  透明置顶窗口，常驻桌面右下角
                </div>
              </div>

              {petConfig.enabled && (
                <div className="form-group">
                  <div className="form-label">选择形象</div>
                  <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
                    双击桌面形象也可快速切换
                  </div>
                  <div className="pet-character-grid">
                    {PET_CHARACTERS.map((char) => (
                      <div
                        key={char}
                        className={`pet-character-option ${petConfig.character === char ? "selected" : ""}`}
                        onClick={() => handlePetCharacterChange(char)}
                      >
                        <PetPreview character={char} />
                        <div className="label">{PET_CHARACTER_LABELS[char]}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 20, padding: 12, background: "var(--color-bg)", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>操作说明</div>
                <div style={{ color: "var(--color-text-secondary)", lineHeight: 1.8 }}>
                  · 左键点击：打开主窗口<br/>
                  · 双击：切换形象<br/>
                  · 右键：显示/隐藏主窗口<br/>
                  · 拖动：移动位置<br/>
                  · 状态指示：绿色=记录中 / 橙色=暂停 / 紫色=隐私模式
                </div>
              </div>
            </div>
          )}

          {/* Intelligence Settings */}
          {activeTab === "intelligence" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
                <BellIcon size={18} />
                主动智能
              </h2>
              <div className="text-sm text-muted" style={{ marginBottom: 20 }}>
                洞察卡片、智能提醒、异常检测
              </div>

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={configForm.insightsEnabled ?? true}
                    onChange={(e) => updateConfig({ insightsEnabled: e.target.checked })}
                  />
                  工作洞察
                </label>
                <div className="text-sm text-muted" style={{ marginLeft: 24, marginTop: 4 }}>
                  分析工作模式，生成洞察卡片（高效时段、应用使用、生产力建议等）
                </div>
              </div>

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={configForm.smartReminderEnabled ?? true}
                    onChange={(e) => updateConfig({ smartReminderEnabled: e.target.checked })}
                  />
                  智能提醒
                </label>
                <div className="text-sm text-muted" style={{ marginLeft: 24, marginTop: 4 }}>
                  每日总结提醒、长时间会话提醒、下班提醒、周报提醒
                </div>
              </div>

              <div className="form-group">
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={configForm.anomalyDetectionEnabled ?? true}
                    onChange={(e) => updateConfig({ anomalyDetectionEnabled: e.target.checked })}
                  />
                  异常检测
                </label>
                <div className="text-sm text-muted" style={{ marginLeft: 24, marginTop: 4 }}>
                  检测异常应用使用、异常时段工作、异常工作时长
                </div>
              </div>

              <div style={{ marginTop: 20, padding: 12, background: "var(--color-bg)", borderRadius: "var(--radius-md)", fontSize: 13 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>说明</div>
                <div style={{ color: "var(--color-text-secondary)", lineHeight: 1.8 }}>
                  · 洞察基于最近 7 天的工作数据自动生成<br/>
                  · 应用启动 10 秒后自动刷新洞察<br/>
                  · 可在"洞察"页面手动刷新和查看<br/>
                  · 所有分析在本地完成，不上传数据
                </div>
              </div>
            </div>
          )}

          {/* Data Management */}
          {activeTab === "data" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>数据管理</h2>

              <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>清空今日记录</div>
                    <div className="text-sm text-muted">删除今天的所有工作片段</div>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={handleClearToday}>
                    清空今日
                  </button>
                </div>
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>清空所有数据</div>
                    <div className="text-sm text-muted">删除所有历史记录、配置和日报</div>
                  </div>
                  <button className="btn btn-danger btn-sm" onClick={handleClearAll}>
                    清空全部
                  </button>
                </div>
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>清空 API Key</div>
                    <div className="text-sm text-muted">删除所有已保存的 AI 配置</div>
                  </div>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={handleClearAiConfigs}
                  >
                    清空
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* About */}
          {activeTab === "about" && (
            <div>
              <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>关于</h2>

              <div className="card">
                <div style={{ textAlign: "center", padding: "24px 0" }}>
                  <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
                    今日记忆
                  </div>
                  <div style={{ fontSize: 14, color: "var(--color-text-secondary)", marginBottom: 4 }}>
                    WorkMemory v0.3.0
                  </div>
                  <div style={{ fontSize: 13, color: "var(--color-text-muted)" }}>
                    个人工作记忆助手
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 16, fontSize: 13, color: "var(--color-text-secondary)", lineHeight: 1.8 }}>
                <p>
                  今日记忆是一款面向个人职场用户的 Windows 本地工作记忆助手。
                  通过本地 OCR 自动整理当天电脑工作痕迹，并基于用户确认的内容生成排版好的日报。
                </p>
                <p style={{ marginTop: 12 }}>
                  产品定位为个人工具，不是企业监管软件。
                </p>
                <p style={{ marginTop: 12 }}>
                  本地优先，隐私可控。不记录键盘输入，不自动上传截图，AI 生成前必须用户确认。
                </p>
                <p style={{ marginTop: 12 }}>
                  V3 新增：桌面常驻形象、人/事/时间记忆图谱、Wiki 双链知识库、主动智能（洞察/提醒/异常检测）。
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// === Pet Preview (小型 SVG 预览) ===
function PetPreview({ character }: { character: PetCharacter }) {
  const color = "#3b82f6";
  return (
    <svg width="40" height="40" viewBox="0 0 120 120">
      {character === "cat" && (
        <g>
          <ellipse cx="60" cy="70" rx="32" ry="26" fill={color} />
          <circle cx="60" cy="48" r="24" fill={color} />
          <polygon points="42,32 38,16 52,28" fill={color} />
          <polygon points="78,32 82,16 68,28" fill={color} />
          <circle cx="54" cy="47" r="3.5" fill="#1f2937" />
          <circle cx="66" cy="47" r="3.5" fill="#1f2937" />
        </g>
      )}
      {character === "robot" && (
        <g>
          <line x1="60" y1="20" x2="60" y2="32" stroke="#6b7280" strokeWidth="2" />
          <circle cx="60" cy="18" r="4" fill={color} />
          <rect x="38" y="32" width="44" height="36" rx="8" fill={color} />
          <rect x="44" y="40" width="32" height="16" rx="3" fill="#1f2937" />
          <circle cx="52" cy="48" r="3" fill="#10b981" />
          <circle cx="68" cy="48" r="3" fill="#10b981" />
          <rect x="42" y="70" width="36" height="32" rx="6" fill={color} />
        </g>
      )}
      {character === "ghost" && (
        <path
          d="M60 20 C40 20 32 38 32 58 L32 92 Q36 88 40 92 Q44 96 48 92 Q52 88 56 92 Q60 96 64 92 Q68 88 72 92 Q76 96 80 92 Q84 88 88 92 L88 58 C88 38 80 20 60 20 Z"
          fill={color}
        />
      )}
      {character === "droplet" && (
        <path
          d="M60 18 C60 18 38 48 38 68 C38 84 48 96 60 96 C72 96 82 84 82 68 C82 48 60 18 60 18 Z"
          fill={color}
        />
      )}
      {character === "fox" && (
        <g>
          <ellipse cx="58" cy="72" rx="28" ry="22" fill={color} />
          <path d="M60 30 L36 52 L42 58 L60 50 L78 58 L84 52 Z" fill={color} />
          <path d="M60 42 L48 56 L60 62 L72 56 Z" fill="#fff" opacity="0.9" />
          <circle cx="53" cy="50" r="2.5" fill="#1f2937" />
          <circle cx="67" cy="50" r="2.5" fill="#1f2937" />
        </g>
      )}
      {character === "star" && (
        <path
          d="M60 20 L68 48 L96 48 L74 64 L82 92 L60 76 L38 92 L46 64 L24 48 L52 48 Z"
          fill={color}
        />
      )}
    </svg>
  );
}
