import crypto from "crypto";
import { RecorderStatus, WindowSnapshot, IPC_CHANNELS } from "../../shared/types";
import { windowWatcher } from "./window-watcher";
import { privacyGuard } from "./privacy-guard";
import { captureService } from "./capture";
import { ocrService } from "./ocr";
import { segmentMerger } from "./segment-merger";
import { segmentRepo } from "../database/repositories/segment-repo";
import { configRepo } from "../database/repositories/config-repo";
import { eventLogRepo } from "../database/repositories/event-log-repo";

/**
 * RecorderService - 记录编排器
 * 管理记录状态，并编排完整的记录主循环：
 * 窗口监听 → 隐私检查 → 节流检查 → 截屏 → OCR → 去重合并 → 持久化
 */
export class RecorderService {
  private status: RecorderStatus = "initializing";
  private listeners: Array<(status: RecorderStatus) => void> = [];
  private watching: boolean = false;
  private lastCaptureTime: number = 0;
  private lastTextHash: string | null = null;
  private processing: boolean = false;

  getStatus(): RecorderStatus {
    return this.status;
  }

  setStatus(status: RecorderStatus): void {
    const previous = this.status;
    this.status = status;
    this.notifyListeners();
    this.handleStatusTransition(previous, status);
  }

  start(): void {
    this.setStatus("recording");
  }

  pause(): void {
    this.setStatus("paused");
  }

  resume(): void {
    this.setStatus("recording");
  }

  enablePrivacyMode(): void {
    this.setStatus("privacy_mode");
  }

  disablePrivacyMode(): void {
    this.setStatus("recording");
  }

  setError(): void {
    this.setStatus("error");
  }

  isRecording(): boolean {
    return this.status === "recording";
  }

  isPaused(): boolean {
    return this.status === "paused";
  }

  isPrivacyMode(): boolean {
    return this.status === "privacy_mode";
  }

  onStatusChange(listener: (status: RecorderStatus) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * 根据状态变化启停窗口监听
   */
  private handleStatusTransition(previous: RecorderStatus, current: RecorderStatus): void {
    const shouldWatch = current === "recording" || current === "privacy_mode";
    if (shouldWatch && !this.watching) {
      this.startWatching();
    } else if (!shouldWatch && this.watching) {
      this.stopWatching();
    }
  }

  /**
   * 启动窗口监听
   */
  private startWatching(): void {
    if (this.watching) return;
    this.watching = true;
    windowWatcher.startWatching(
      (snapshot) => {
        this.handleWindowChange(snapshot).catch((err) => {
          console.error("RecorderService: handleWindowChange error:", err);
        });
      },
      2000
    );
    eventLogRepo.info("recorder", "窗口监听已启动");
  }

  /**
   * 停止窗口监听
   */
  private stopWatching(): void {
    if (!this.watching) return;
    this.watching = false;
    windowWatcher.stopWatching();
    eventLogRepo.info("recorder", "窗口监听已停止");
  }

  /**
   * 记录主循环：处理窗口变化事件
   * 流程：隐私检查 → 合并检查 → 节流检查 → 截屏 → OCR → 去重 → 持久化
   */
  private async handleWindowChange(snapshot: WindowSnapshot): Promise<void> {
    // 防止并发处理
    if (this.processing) return;
    // 非记录状态跳过（privacy_mode 下也跳过实际截屏，只创建占位）
    if (!this.isRecording() && !this.isPrivacyMode()) return;

    this.processing = true;
    try {
      const config = await configRepo.getConfig();
      const today = new Date().toISOString().split("T")[0];

      // 1. 隐私检查（PRD 7.7 节）
      const isPrivate = await privacyGuard.isPrivate(snapshot);
      if (isPrivate) {
        await this.handlePrivateWindow(snapshot, config.privacyAction, today);
        return;
      }

      // 隐私模式下，非隐私窗口也不记录
      if (this.isPrivacyMode()) return;

      // 2. 合并检查：是否可以延长上一个片段
      const lastSegment = await segmentRepo.getLastSegment(today);
      if (lastSegment && !lastSegment.isPrivate) {
        const canExtend = await segmentMerger.canExtendSegment(lastSegment, snapshot);
        if (canExtend) {
          await segmentMerger.extendSegment(lastSegment.id);
          this.notifySegmentChange();
          return;
        }
      }

      // 3. 节流检查（PRD 7.3 节 minScreenshotIntervalSeconds）
      const now = Date.now();
      const elapsedSeconds = (now - this.lastCaptureTime) / 1000;
      if (elapsedSeconds < config.minScreenshotIntervalSeconds) {
        return;
      }

      // 4. 截屏
      const captureResult = await captureService.capture();
      if (!captureResult) {
        await eventLogRepo.error("recorder", "截屏失败", `appName=${snapshot.appName}`);
        return;
      }
      this.lastCaptureTime = now;

      // 5. 创建新片段
      const segment = await segmentMerger.createSegment(snapshot);

      // 6. OCR 识别
      const ocrResult = await ocrService.runOcr({
        imagePath: captureResult.imagePath,
        language: config.ocrLanguage,
        segmentId: segment.id,
      });

      // 7. 文本去重（PRD 7.5 节 textHash）
      if (ocrResult.text) {
        const textHash = crypto.createHash("md5").update(ocrResult.text).digest("hex");
        if (this.lastTextHash === textHash) {
          // 内容重复 - 删除此片段
          await segmentRepo.softDeleteSegment(segment.id);
          captureService.deleteTempScreenshot(captureResult.imagePath);
          await eventLogRepo.info(
            "recorder",
            "检测到重复内容，已跳过",
            `textHash=${textHash}`
          );
          return;
        }
        this.lastTextHash = textHash;
        await segmentRepo.updateSegment(segment.id, { textHash });
      }

      // 8. 截图持久化处理
      if (config.saveScreenshots) {
        const permanentPath = captureService.moveToPermanent(
          captureResult.imagePath,
          segment.id
        );
        if (permanentPath) {
          await segmentRepo.updateSegment(segment.id, {
            screenshotPath: permanentPath,
            screenshotSaved: true,
          });
        }
      } else {
        captureService.deleteTempScreenshot(captureResult.imagePath);
      }

      // 9. 通知渲染进程刷新
      this.notifySegmentChange();

      await eventLogRepo.info(
        "recorder",
        "新片段已记录",
        `app=${snapshot.appName}, ocrLen=${ocrResult.text?.length || 0}`
      );
    } catch (error: any) {
      console.error("RecorderService: 记录流程错误:", error);
      await eventLogRepo.error(
        "recorder",
        `记录流程错误: ${error?.message || "未知错误"}`,
        error?.stack
      );
    } finally {
      this.processing = false;
    }
  }

  /**
   * 处理隐私窗口
   */
  private async handlePrivateWindow(
    snapshot: WindowSnapshot,
    action: "skip" | "placeholder",
    today: string
  ): Promise<void> {
    if (action === "skip") {
      // 完全跳过，不创建任何片段
      return;
    }

    // placeholder 模式：创建隐私占位片段
    const lastSegment = await segmentRepo.getLastSegment(today);
    if (lastSegment && lastSegment.isPrivate) {
      // 延长已有隐私片段
      await segmentMerger.extendSegment(lastSegment.id);
    } else {
      await segmentMerger.createPrivateSegment();
    }
    this.notifySegmentChange();
  }

  /**
   * 通知渲染进程片段已变化
   */
  private notifySegmentChange(): void {
    try {
      const { getMainWindow } = require("../window");
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.ON_SEGMENT_CHANGE);
      }
    } catch {
      // window 模块可能尚未加载
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.status);
      } catch (e) {
        console.error("RecorderService listener error:", e);
      }
    }
  }
}

export const recorderService = new RecorderService();
