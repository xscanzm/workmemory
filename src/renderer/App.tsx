import React, { useEffect } from "react";
import { useAppStore } from "./stores/app-store";
import { TodayTimeline } from "./pages/TodayTimeline";
import { ReportGenerator } from "./pages/ReportGenerator";
import { TemplateCenter } from "./pages/TemplateCenter";
import { Settings } from "./pages/Settings";
import { MemoryCalendar } from "./pages/MemoryCalendar";
import { MemorySearch } from "./pages/MemorySearch";
import { WorkInsights } from "./pages/WorkInsights";
import { MemoryGraph } from "./pages/MemoryGraph";
import { KnowledgeBase } from "./pages/KnowledgeBase";
import { ProactiveInsights } from "./pages/ProactiveInsights";
import { Toast } from "./components/Toast";
import { Onboarding } from "./components/Onboarding";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import {
  PlayIcon,
  PauseIcon,
  ShieldIcon,
  LayoutIcon,
  FileTextIcon,
  EditIcon,
  SettingsIcon,
  ClockIcon,
  SearchIcon,
  SparklesIcon,
  UsersIcon,
  BookIcon,
} from "./components/Icons";

const api = window.workmemory;

export default function App() {
  const { currentRoute, setRoute, recorderStatus, setRecorderStatus, toast } = useAppStore();
  useKeyboardShortcuts();

  useEffect(() => {
    const unsub = api.onRecorderStatusChange((status) => {
      setRecorderStatus(status as any);
    });
    const unsubNav = api.onNavigate((route) => {
      setRoute(route);
    });
    api.getRecorderStatus().then((status) => {
      setRecorderStatus(status);
    });
    return () => {
      unsub();
      unsubNav();
    };
  }, []);

  const statusLabel: Record<string, string> = {
    recording: "记录中",
    paused: "已暂停",
    privacy_mode: "隐私模式",
    error: "错误",
    initializing: "初始化中",
  };

  const navItems = [
    { route: "/", label: "今日", icon: <LayoutIcon size={15} /> },
    { route: "/calendar", label: "日历", icon: <ClockIcon size={15} /> },
    { route: "/search", label: "搜索", icon: <SearchIcon size={15} /> },
    { route: "/graph", label: "图谱", icon: <UsersIcon size={15} /> },
    { route: "/insights", label: "洞察", icon: <SparklesIcon size={15} /> },
    { route: "/wiki", label: "知识库", icon: <BookIcon size={15} /> },
    { route: "/report", label: "日报", icon: <FileTextIcon size={15} /> },
    { route: "/templates", label: "模板", icon: <EditIcon size={15} /> },
    { route: "/settings", label: "设置", icon: <SettingsIcon size={15} /> },
  ];

  const handleToggleRecord = () => {
    if (recorderStatus === "recording" || recorderStatus === "privacy_mode") {
      api.setRecorderStatus("paused");
    } else {
      api.setRecorderStatus("recording");
    }
  };

  const isRecording = recorderStatus === "recording" || recorderStatus === "privacy_mode";

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-header-left">
          <h1 style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3, marginRight: 8 }}>今日记忆</h1>
          <div className="nav-tabs" style={{ flexWrap: "wrap" }}>
            {navItems.map((item) => (
              <button
                key={item.route}
                className={`nav-tab ${currentRoute === item.route ? "active" : ""}`}
                onClick={() => setRoute(item.route)}
                title={item.label}
              >
                {item.icon}
                <span style={{ display: "inline" }}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="app-header-right">
          <span className={`status-badge ${recorderStatus}`}>
            {statusLabel[recorderStatus] || recorderStatus}
          </span>
          {recorderStatus === "privacy_mode" ? (
            <button className="btn btn-sm" onClick={() => api.setRecorderStatus("recording")}>
              <ShieldIcon size={14} />
              退出隐私
            </button>
          ) : (
            <button className="btn btn-sm" onClick={handleToggleRecord}>
              {isRecording ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
              {isRecording ? "暂停" : "恢复"}
            </button>
          )}
        </div>
      </header>

      <main className="app-content">
        {currentRoute === "/" && <TodayTimeline />}
        {currentRoute === "/calendar" && <MemoryCalendar />}
        {currentRoute === "/search" && <MemorySearch />}
        {currentRoute === "/graph" && <MemoryGraph />}
        {currentRoute === "/insights" && <ProactiveInsights />}
        {currentRoute === "/wiki" && <KnowledgeBase />}
        {currentRoute === "/report" && <ReportGenerator />}
        {currentRoute === "/templates" && <TemplateCenter />}
        {currentRoute === "/settings" && <Settings />}
      </main>

      {toast && <Toast />}
      <Onboarding />
    </div>
  );
}
