import { WindowSnapshot, PetEmotionState } from "../../shared/types";

/**
 * WindowWatcher - 活跃窗口监听服务
 * 使用 active-win 获取前台窗口信息
 */
export class WindowWatcher {
  private watchInterval: NodeJS.Timeout | null = null;
  private lastSnapshot: WindowSnapshot | null = null;
  private onWindowChange: ((snapshot: WindowSnapshot) => void) | null = null;

  // === 情绪追踪相关字段 ===
  private windowSwitchHistory: number[] = []; // 最近3分钟每分钟的切换次数
  private currentMinuteSwitches = 0;
  private emotionTimer: NodeJS.Timeout | null = null;
  private onEmotionCallback: ((state: PetEmotionState) => void) | null = null;

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
        // 窗口切换时递增当前分钟计数（用于情绪追踪）
        this.currentMinuteSwitches++;
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

  /**
   * 开始情绪追踪（3分钟滑窗算法）
   * 每分钟评估一次：根据最近3分钟累计的窗口切换次数判定情绪状态
   * - DEEP_WORK: 累计切换 ≤2 次（低切换频次视为专注）
   * - ANXIOUS: 累计切换 ≥7 次（高切换频次视为焦虑）
   * - IDLE: 其他情况
   */
  startEmotionTracking(onEmotion: (state: PetEmotionState) => void): void {
    this.stopEmotionTracking();
    this.onEmotionCallback = onEmotion;
    this.windowSwitchHistory = [];
    this.currentMinuteSwitches = 0;

    this.emotionTimer = setInterval(() => {
      // 每分钟：推入历史，保留最近3分钟
      this.windowSwitchHistory.push(this.currentMinuteSwitches);
      if (this.windowSwitchHistory.length > 3) {
        this.windowSwitchHistory.shift();
      }
      const totalSwitches = this.windowSwitchHistory.reduce((a, b) => a + b, 0);

      let state: PetEmotionState = "IDLE";
      if (totalSwitches <= 2) {
        state = "DEEP_WORK"; // 低切换频次视为专注
      } else if (totalSwitches >= 7) {
        state = "ANXIOUS"; // 高切换频次视为焦虑
      }

      this.onEmotionCallback?.(state);
      this.currentMinuteSwitches = 0; // 重置当前分钟计数
    }, 60000);
  }

  /**
   * 停止情绪追踪
   */
  stopEmotionTracking(): void {
    if (this.emotionTimer) {
      clearInterval(this.emotionTimer);
      this.emotionTimer = null;
    }
    this.onEmotionCallback = null;
    this.windowSwitchHistory = [];
    this.currentMinuteSwitches = 0;
  }
}

export const windowWatcher = new WindowWatcher();