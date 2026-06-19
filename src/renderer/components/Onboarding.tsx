import React, { useState, useEffect } from "react";
import { useAppStore } from "../stores/app-store";
import { SparklesIcon, ShieldIcon, FileTextIcon, CheckIcon } from "./Icons";

const STORAGE_KEY = "workmemory_onboarding_done";

export function Onboarding() {
  const { setRoute } = useAppStore();
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const done = localStorage.getItem(STORAGE_KEY);
    if (!done) {
      setVisible(true);
    }
  }, []);

  const handleFinish = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  const handleSkip = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  if (!visible) return null;

  const steps = [
    {
      icon: <SparklesIcon size={48} />,
      title: "欢迎使用今日记忆",
      desc: "一款本地优先的工作记忆助手。自动记录你的窗口活动，帮你生成日报，让工作痕迹不再丢失。",
      action: "开始使用",
    },
    {
      icon: <ShieldIcon size={48} />,
      title: "隐私可控",
      desc: "所有数据存储在本地。不记录键盘输入，不自动上传截图。已预置隐私黑名单，敏感窗口自动跳过。AI 生成前必须你确认。",
      action: "了解",
    },
    {
      icon: <FileTextIcon size={48} />,
      title: "三步生成日报",
      desc: "1. 在今日记忆轴勾选要参与的片段\n2. 在生成日报页选择模板并确认\n3. 编辑后导出 Markdown 或 Word",
      action: "完成",
    },
  ];

  const current = steps[step];

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      handleFinish();
    }
  };

  return (
    <div className="onboarding-overlay" onClick={handleSkip}>
      <div className="onboarding-card" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            color: "var(--color-primary)",
            marginBottom: 20,
            display: "flex",
            justifyContent: "center",
          }}
        >
          {current.icon}
        </div>

        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
          {current.title}
        </h2>

        <div
          style={{
            fontSize: 14,
            color: "var(--color-text-secondary)",
            lineHeight: 1.8,
            marginBottom: 28,
            whiteSpace: "pre-line",
          }}
        >
          {current.desc}
        </div>

        {/* Step indicator */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 6,
            marginBottom: 24,
          }}
        >
          {steps.map((_, i) => (
            <div
              key={i}
              style={{
                width: i === step ? 24 : 6,
                height: 6,
                borderRadius: 3,
                background:
                  i === step
                    ? "var(--color-primary)"
                    : i < step
                    ? "var(--color-primary-lighter)"
                    : "var(--color-border)",
                transition: "all 0.3s",
              }}
            />
          ))}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {step > 0 && (
            <button
              className="btn"
              style={{ flex: 1 }}
              onClick={() => setStep(step - 1)}
            >
              上一步
            </button>
          )}
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={handleNext}
          >
            {step === steps.length - 1 ? (
              <>
                <CheckIcon size={14} />
                {current.action}
              </>
            ) : (
              current.action
            )}
          </button>
        </div>

        <button
          onClick={handleSkip}
          style={{
            background: "none",
            border: "none",
            color: "var(--color-text-muted)",
            fontSize: 12,
            cursor: "pointer",
            marginTop: 16,
          }}
        >
          跳过引导
        </button>
      </div>
    </div>
  );
}
