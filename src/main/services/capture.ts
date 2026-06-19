import path from "path";
import fs from "fs";
import os from "os";
import { app } from "electron";

/**
 * CaptureService - 截屏服务
 * P0: 使用 screenshot-desktop 库
 * 默认截图保存为临时文件，OCR 后删除
 */
export class CaptureService {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(app.getPath("temp"), "workmemory-screenshots");
    this.ensureTempDir();
  }

  /**
   * 截取当前屏幕并保存为临时文件
   */
  async capture(): Promise<{ imagePath: string; buffer: Buffer } | null> {
    try {
      const screenshot = require("screenshot-desktop");
      const buffer = await screenshot({ format: "png" });
      const timestamp = Date.now();
      const filename = `screenshot_${timestamp}.png`;
      const imagePath = path.join(this.tempDir, filename);

      fs.writeFileSync(imagePath, buffer);
      return { imagePath, buffer };
    } catch (error) {
      console.error("CaptureService: Failed to capture screen:", error);
      return null;
    }
  }

  /**
   * 删除临时截图
   */
  deleteTempScreenshot(imagePath: string): void {
    try {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch (error) {
      console.error("CaptureService: Failed to delete temp screenshot:", error);
    }
  }

  /**
   * 将截图移动到持久化目录
   */
  moveToPermanent(imagePath: string, segmentId: string): string | null {
    try {
      const screenshotsDir = path.join(app.getPath("userData"), "screenshots");
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }

      const ext = path.extname(imagePath);
      const newPath = path.join(screenshotsDir, `${segmentId}${ext}`);
      fs.renameSync(imagePath, newPath);
      return newPath;
    } catch (error) {
      console.error("CaptureService: Failed to move screenshot:", error);
      return null;
    }
  }

  /**
   * 清理临时目录
   */
  cleanTempDir(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        const files = fs.readdirSync(this.tempDir);
        for (const file of files) {
          fs.unlinkSync(path.join(this.tempDir, file));
        }
      }
    } catch (error) {
      console.error("CaptureService: Failed to clean temp dir:", error);
    }
  }

  private ensureTempDir(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }
}

export const captureService = new CaptureService();