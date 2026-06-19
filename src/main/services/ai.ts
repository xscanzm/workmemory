import { aiConfigRepo } from "../database/repositories/ai-config-repo";
import { segmentRepo } from "../database/repositories/segment-repo";
import { templateRepo } from "../database/repositories/template-repo";
import { renderTemplate, formatSegmentsForPrompt } from "./templates";
import { AiGenerationInput, AiSegmentInput } from "../../shared/types";

/**
 * AiService - AI 日报生成服务
 */
export class AiService {
  async buildAiInput(
    date: string,
    templateId: string,
    userNotes?: string
  ): Promise<{
    input: AiGenerationInput;
    promptRendered: string;
    segments: AiSegmentInput[];
  } | null> {
    const template = await templateRepo.getById(templateId);
    if (!template) return null;

    const todaySegments = await segmentRepo.getTodaySegments(date);
    const selectedSegments = todaySegments.filter((s) => s.isSelectedForReport && !s.isDeleted);

    const aiSegments: AiSegmentInput[] = selectedSegments.map((s) => ({
      start_time: s.startTime.split("T")[1]?.substring(0, 5) || s.startTime,
      end_time: s.endTime.split("T")[1]?.substring(0, 5) || s.endTime,
      app_name: s.appName,
      title: s.userTitle || s.windowTitle,
      summary: s.userSummary || s.ocrSummary || s.ocrText?.substring(0, 200) || "",
      user_note: s.userNote,
      tags: s.tags,
    }));

    const segmentsText = formatSegmentsForPrompt(selectedSegments);
    const promptRendered = renderTemplate(template.prompt, {
      date,
      selected_segments: segmentsText,
      user_notes: userNotes || "",
      timeline: "",
      project_tags: "",
      output_style: "",
      audience: "",
      length: "",
    });

    const input: AiGenerationInput = {
      date,
      template: template.name,
      segments: aiSegments,
      constraints: {
        do_not_fabricate: true,
        only_use_selected_segments: true,
        language: "zh-CN",
      },
    };

    return { input, promptRendered, segments: aiSegments };
  }

  async generateReport(
    prompt: string,
    configId?: string
  ): Promise<{ content: string; error?: string }> {
    const config = configId
      ? await aiConfigRepo.getById(configId)
      : await aiConfigRepo.getDefault();

    if (!config) {
      return { content: "", error: "未配置 AI 服务，请先在设置中配置 API Key" };
    }

    const apiKey = await aiConfigRepo.getDecryptedApiKey(config.id);
    if (!apiKey) {
      return { content: "", error: "无法获取 API Key" };
    }

    try {
      const url = `${config.baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: config.temperature,
          max_tokens: config.maxTokens || 4096,
          stream: false,
        }),
        signal: AbortSignal.timeout(config.timeoutSeconds * 1000),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 401) {
          return { content: "", error: "API Key 认证失败，请检查配置" };
        }
        if (response.status === 429) {
          return { content: "", error: "API 请求频率超限，请稍后重试" };
        }
        return {
          content: "",
          error: `AI 请求失败 (${response.status}): ${errorBody.substring(0, 200)}`,
        };
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || "";

      return { content };
    } catch (error: any) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        return { content: "", error: "AI 请求超时，请检查网络或增加超时时间" };
      }
      return {
        content: "",
        error: `AI 请求失败: ${error?.message || "未知错误"}`,
      };
    }
  }

  async testConnection(configId?: string): Promise<{ success: boolean; error?: string }> {
    const config = configId
      ? await aiConfigRepo.getById(configId)
      : await aiConfigRepo.getDefault();

    if (!config) {
      return { success: false, error: "未配置 AI 服务" };
    }

    const apiKey = await aiConfigRepo.getDecryptedApiKey(config.id);
    if (!apiKey) {
      return { success: false, error: "无法获取 API Key" };
    }

    try {
      const url = `${config.baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 5,
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        return { success: true };
      }

      const errorBody = await response.text();
      if (response.status === 401) {
        return { success: false, error: "API Key 无效" };
      }

      return { success: false, error: `连接失败 (${response.status}): ${errorBody.substring(0, 200)}` };
    } catch (error: any) {
      return {
        success: false,
        error: `连接失败: ${error?.message || "未知错误"}`,
      };
    }
  }
}

export const aiService = new AiService();