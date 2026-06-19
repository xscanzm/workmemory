import { WindowSnapshot } from "../../shared/types";

/**
 * WindowWatcher - 活跃窗口监听服务
 * 使用 active-win 获取前台窗口信息
 */
export class WindowWatcher {
  private watchInterval: NodeJS.Timeout | null = null;
  private lastSnapshot: WindowSnapshot | null = null;
  private onWindowChange: ((snapshot: WindowSnapshot) => void) | null = null;

  /**
   * 获取当前前台窗口快照
   */
  async getCurrentWindow(): Promise<WindowSnapshot | null> {
    try {
      // active-win is a native module, wrapped in try-catch for environments without it
      const activeWin = require("active-win");
      const result = await activeWin();

      if (!result) return null;

      return {
        capturedAt: new Date().toISOString(),
        appName: result.owner?.name || "Unknown",
        processName: result.owner?.processId?.toString() || "Unknown",
        processPath: result.owner?.path || undefined,
        windowTitle: result.title || "",
        windowHandle: result.id?.toString() || "",
        monitorId: undefined,
        isIdle: false,
      };
    } catch (error) {
      console.error("WindowWatcher: Failed to get active window:", error);
      return null;
    }
  }

  /**
   * 开始监听窗口变化
   */
  startWatching(
    onChange: (snapshot: WindowSnapshot) => void,
    intervalMs: number = 2000
  ): void {
    this.stopWatching();
    this.onWindowChange = onChange;

    this.watchInterval = setInterval(async () => {
      const snapshot = await this.getCurrentWindow();
      if (!snapshot) return;

      // Check if window changed
      if (this.hasWindowChanged(snapshot)) {
        this.lastSnapshot = snapshot;
        this.onWindowChange?.(snapshot);
      }
    }, intervalMs);
  }

  /**
   * 停止监听
   */
  stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    this.onWindowChange = null;
    this.lastSnapshot = null;
  }

  /**
   * 判断窗口是否发生变化
   */
  private hasWindowChanged(snapshot: WindowSnapshot): boolean {
    if (!this.lastSnapshot) return true;

    return (
      this.lastSnapshot.windowTitle !== snapshot.windowTitle ||
      this.lastSnapshot.appName !== snapshot.appName ||
      this.lastSnapshot.processName !== snapshot.processName
    );
  }
}

export const windowWatcher = new WindowWatcher();