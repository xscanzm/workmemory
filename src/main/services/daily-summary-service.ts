import { segmentRepo } from "../database/repositories/segment-repo";
import { dailySummaryRepo } from "../database/repositories/daily-summary-repo";
import { configRepo } from "../database/repositories/config-repo";
import { aiConfigRepo } from "../database/repositories/ai-config-repo";
import { aiService } from "./ai";
import { DailySummary, NarrativeResult, WorkSegment } from "../../shared/types";

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

  /**
   * 生成文学化周叙事（第二人称）
   */
  async generateNarrative(weekId: number): Promise<NarrativeResult> {
    const now = new Date();
    const weekAgo = new Date();
    weekAgo.setDate(now.getDate() - 7);
    const startDate = weekAgo.toISOString().split("T")[0];
    const endDate = now.toISOString().split("T")[0];

    // 获取本周所有片段
    const segments = await segmentRepo.getByDateRange(startDate, endDate);

    let narrativeText = "";
    let generatedBy: "ai" | "rule" = "rule";

    try {
      narrativeText = await this.generateNarrativeByAi(segments);
      generatedBy = "ai";
    } catch (error) {
      console.warn("Narrative AI generation failed, fallback to rule:", error);
    }

    if (!narrativeText) {
      narrativeText = this.generateNarrativeByRule(segments);
      generatedBy = "rule";
    }

    return {
      narrativeText,
      weekId,
      generatedAt: new Date().toISOString(),
      generatedBy,
    };
  }

  private async generateNarrativeByAi(segments: WorkSegment[]): Promise<string> {
    const config = await configRepo.getConfig();
    if (!config.aiProviderConfigId) throw new Error("No AI config");

    const aiConfig = await aiConfigRepo.getById(config.aiProviderConfigId);
    if (!aiConfig) throw new Error("AI config not found");

    // 汇总本周 OCR 文本摘要
    const ocrSummaries = segments
      .slice(0, 50) // 限制输入量
      .map((s) => `[${s.appName}] ${s.ocrSummary || s.windowTitle || ""}`)
      .join("\n");

    const prompt = `【核心人格】你绝不是数据统计器。你是用户最信任、最理解他辛劳的数字伙伴。
【输入分析】请审计用户本周的所有屏幕 OCR 切片。请精准找出他最专注、最发光的 2-3 个核心工作挑战。
【文字要求】使用诗意、有同理心、温暖的第二人称（你）口吻来撰写。字数 180 字以内。
【铁律】严禁使用任何结构词（首先、其次、综上等）。最后必须以一句祝他周末彻底合上电脑、去享受真实热烈生活的话语温柔收尾。

本周工作切片：
${ocrSummaries}`;

    const result = await aiService.chat(aiConfig, prompt);
    return result.trim();
  }

  private generateNarrativeByRule(segments: WorkSegment[]): string {
    const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
    const hours = Math.floor(totalDuration / 3600);
    const appSet = new Set(segments.map((s) => s.appName));

    return `这一周，你在屏幕前度过了 ${hours} 个小时，穿梭于 ${appSet.size} 个应用之间。那些看似琐碎的片段，拼凑出你认真对待每一个任务的模样。你专注时的沉默，比任何喧嚣都更有力量。现在，合上电脑吧，去享受属于你的真实生活，你值得。`;
  }
}

export const dailySummaryService = new DailySummaryService();
