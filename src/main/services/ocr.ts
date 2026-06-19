import { OcrRequest, OcrResult } from "../../shared/types";
import { segmentRepo } from "../database/repositories/segment-repo";
import { configRepo } from "../database/repositories/config-repo";

/**
 * OcrService - OCR 适配层
 * P0: 使用 PaddleOCR（通过 subprocess 调用）
 */
export class OcrService {
  async runOcr(request: OcrRequest): Promise<OcrResult> {
    const config = await configRepo.getConfig();
    const startTime = Date.now();

    if (config.ocrProvider === "mock") {
      return this.mockOcr(request);
    }

    try {
      const result = await this.runPaddleOcr(request);
      const durationMs = Date.now() - startTime;

      await segmentRepo.updateSegment(request.segmentId, {
        ocrText: result.text,
        ocrConfidence: result.confidence,
        sourceStatus: result.text ? "ocr_done" : "no_text",
      });

      return { ...result, durationMs };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      await segmentRepo.updateSegment(request.segmentId, {
        sourceStatus: "ocr_failed",
      });

      return {
        segmentId: request.segmentId,
        text: "",
        durationMs,
        error: error?.message || "OCR failed",
      };
    }
  }

  private async runPaddleOcr(request: OcrRequest): Promise<OcrResult> {
    const { execSync } = require("child_process");
    const lang = request.language === "ch_en" ? "ch" : request.language;

    try {
      const command = `paddleocr --image_dir "${request.imagePath}" --lang ${lang} --use_angle_cls true --use_gpu false`;
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const lines = output
        .split("\n")
        .filter((line: string) => line.trim())
        .map((line: string) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const rawText = lines
        .map((item: any) => item?.text || "")
        .join(" ")
        .trim();

      // OCR 文本压缩（PRD 7.4 节）：去除多余空白、合并连续空格、限制长度
      const text = this.compressOcrText(rawText);

      const confidence =
        lines.length > 0
          ? lines.reduce((sum: number, item: any) => sum + (item?.confidence || 0), 0) /
            lines.length
          : undefined;

      return {
        segmentId: request.segmentId,
        text,
        confidence,
        blocks: lines.map((item: any) => ({
          text: item?.text || "",
          confidence: item?.confidence,
          box: item?.box,
        })),
        durationMs: 0,
      };
    } catch (error: any) {
      console.error("OcrService: PaddleOCR error:", error?.message);
      throw error;
    }
  }

  /**
   * OCR 文本压缩（PRD 7.4 节）
   * - 合并连续空白字符
   * - 去除首尾空白
   * - 限制最大长度（避免过长文本影响 AI 生成）
   */
  private compressOcrText(text: string, maxLength: number = 2000): string {
    return text
      .replace(/[\t\r\n]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .substring(0, maxLength);
  }

  private mockOcr(request: OcrRequest): OcrResult {
    return {
      segmentId: request.segmentId,
      text: `[Mock OCR] Window content captured at ${new Date().toLocaleTimeString()}`,
      confidence: 0.95,
      durationMs: 10,
    };
  }

  async isAvailable(): Promise<boolean> {
    const config = await configRepo.getConfig();
    if (config.ocrProvider === "mock") return true;

    try {
      const { execSync } = require("child_process");
      execSync("paddleocr --version", { encoding: "utf-8", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

export const ocrService = new OcrService();