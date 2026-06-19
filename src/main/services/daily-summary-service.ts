import { segmentRepo } from "../database/repositories/segment-repo";
import { dailySummaryRepo } from "../database/repositories/daily-summary-repo";
import { aiService } from "./ai";
import { DailySummary } from "../../shared/types";

/**
 * DailySummaryService - 每日一句话总结生成服务
 * 优先使用 AI 生成，失败时降级为规则提取
 */
export class DailySummaryService {
  /**
   * 为指定日期生成一句话总结
   * 如果已存在且 force=false，则跳过
   */
  async generate(date: string, force: boolean = false): Promise<DailySummary | null> {
    const segments = await segmentRepo.getTodaySegments(date);
    if (segments.length === 0) return null;

    // 计算统计数据
    const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
    const appDurationMap = new Map<string, number>();
    for (const s of segments) {
      appDurationMap.set(s.appName, (appDurationMap.get(s.appName) || 0) + s.durationSeconds);
    }
    const topApps = Array.from(appDurationMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([app]) => app);

    // 检查是否已存在
    if (!force) {
      const existing = await dailySummaryRepo.getByDate(date);
      if (existing) return existing;
    }

    // 尝试 AI 生成
    let summary = "";
    let generatedBy: "ai" | "rule" = "rule";

    try {
      summary = await this.generateByAi(date, segments);
      generatedBy = "ai";
    } catch (error) {
      console.warn("DailySummaryService: AI 生成失败，降级为规则提取:", error);
    }

    if (!summary) {
      summary = this.generateByRule(segments, totalDuration, topApps);
      generatedBy = "rule";
    }

    const result: DailySummary = {
      date,
      summary,
      totalDurationSeconds: totalDuration,
      segmentCount: segments.length,
      topApps,
      generatedBy,
      generatedAt: new Date().toISOString(),
    };

    await dailySummaryRepo.save(result);
    return result;
  }

  /**
   * AI 生成一句话总结
   */
  private async generateByAi(date: string, segments: any[]): Promise<string> {
    const appDurationMap = new Map<string, number>();
    for (const s of segments) {
      appDurationMap.set(s.appName, (appDurationMap.get(s.appName) || 0) + s.durationSeconds);
    }
    const topApps: Array<[string, number]> = [];
    for (const [app, dur] of appDurationMap.entries()) {
      topApps.push([app, dur]);
    }
    topApps.sort((a, b) => b[1] - a[1]);
    const top5 = topApps.slice(0, 5);

    const titles = segments
      .slice(0, 15)
      .map((s) => s.userTitle || s.windowTitle)
      .filter(Boolean);

    const prompt = `请用一句中文（不超过30字）总结这天的工作内容。
日期：${date}
主要应用：${top5.map(([app, dur]) => `${app}(${Math.round(dur / 60)}分)`).join("、")}
涉及内容：${titles.join("、")}

要求：
- 只输出一句话，不要前缀
- 概括主要工作内容和重点
- 客观陈述，不要评价`;

    const result = await aiService.generateReport(prompt);
    if (result.error || !result.content) {
      throw new Error(result.error || "AI 返回空内容");
    }

    // 清理：取第一行，去除引号
    return result.content
      .split("\n")[0]
      .replace(/^["""']|["""']$/g, "")
      .trim()
      .substring(0, 50);
  }

  /**
   * 规则提取降级方案：基于应用分布和时长生成
   */
  private generateByRule(segments: any[], totalDuration: number, topApps: string[]): string {
    const hours = Math.round(totalDuration / 3600);
    const minutes = Math.round((totalDuration % 3600) / 60);

    const durationStr = hours > 0 ? `${hours}小时${minutes > 0 ? minutes + "分" : ""}` : `${minutes}分钟`;

    // 提取主要工作内容关键词
    const titleWords = new Set<string>();
    for (const s of segments.slice(0, 10)) {
      const title = s.userTitle || s.windowTitle || "";
      // 提取标题中的关键部分（取前几个字）
      const cleanTitle = title.replace(/[-—|·•:：].*/, "").trim();
      if (cleanTitle && cleanTitle.length > 1) {
        titleWords.add(cleanTitle.substring(0, 8));
      }
    }

    const topAppStr = topApps.slice(0, 2).join("、");
    const contentStr = Array.from(titleWords).slice(0, 2).join("、");

    if (contentStr) {
      return `工作${durationStr}，主要使用${topAppStr}，涉及${contentStr}`;
    }
    return `工作${durationStr}，主要使用${topAppStr}，共${segments.length}个片段`;
  }
}

export const dailySummaryService = new DailySummaryService();
