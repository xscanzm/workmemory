import { useEffect } from "react";
import { useAppStore } from "../stores/app-store";

const api = window.workmemory;

/**
 * useKeyboardShortcuts - 全局快捷键
 * - 空格：暂停/恢复记录（非输入框聚焦时）
 * - Ctrl+G：跳转生成日报
 * - Ctrl+F：跳转搜索
 * - Ctrl+1~7：切换页面（今日/日历/搜索/洞察/日报/模板/设置）
 * - Esc：关闭详情面板
 */
export function useKeyboardShortcuts() {
  const { currentRoute, setRoute, recorderStatus, selectedSegment, setSelectedSegment } = useAppStore();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // 空格：暂停/恢复（非输入框）
      if (e.code === "Space" && !isInput) {
        e.preventDefault();
        if (recorderStatus === "recording") {
          api.setRecorderStatus("paused");
        } else if (recorderStatus === "paused") {
          api.setRecorderStatus("recording");
        }
        return;
      }

      // Esc：关闭详情面板
      if (e.key === "Escape" && selectedSegment) {
        setSelectedSegment(null);
        return;
      }

      // Ctrl/Cmd 组合键
      if (e.ctrlKey || e.metaKey) {
        const routes = ["/", "/calendar", "/search", "/insights", "/report", "/templates", "/settings"];
        const num = parseInt(e.key);
        if (num >= 1 && num <= 7) {
          e.preventDefault();
          setRoute(routes[num - 1]);
          return;
        }
        switch (e.key) {
          case "g":
            e.preventDefault();
            setRoute("/report");
            break;
          case "f":
            e.preventDefault();
            setRoute("/search");
            break;
        }
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [currentRoute, setRoute, recorderStatus, selectedSegment, setSelectedSegment]);
}
