import { WorkSegment } from "../../shared/types";

/**
 * EntityExtractionService - 人/事实体提取服务
 * 从片段的 OCR 文本、窗口标题中提取人物和事件
 * 优先使用 AI，失败时降级为规则匹配
 */
export class EntityExtractionService {
  /**
   * 从片段中提取人物和事件
   * 规则策略：
   * - 人物：从聊天/邮件/会议类应用中提取人名模式
   * - 事件：从标题中提取项目/任务关键词
   */
  extractFromSegment(segment: WorkSegment): { people: string[]; event?: string } {
    const people = new Set<string>();
    let event: string | undefined;

    const text = [
      segment.windowTitle,
      segment.userTitle,
      segment.userSummary,
      segment.ocrSummary,
      segment.ocrText?.substring(0, 500),
    ]
      .filter(Boolean)
      .join(" \n ");

    if (!text) return { people: [], event: undefined };

    // === 人物提取 ===
    // 模式1：聊天应用中的对话对象（微信、QQ、Slack、Teams、钉钉、飞书）
    const chatApps = ["微信", "QQ", "Slack", "Teams", "钉钉", "飞书", "Telegram", "Discord"];
    if (chatApps.some((app) => segment.appName.includes(app))) {
      // 聊天窗口标题通常是 "与 XXX 的对话" 或 "XXX - 应用名"
      const title = segment.windowTitle || "";
      const chatMatch = title.match(/(?:与|和)\s*([^\s\-—|·•:：]+)\s*(?:的对话|聊天)/);
      if (chatMatch) {
        people.add(chatMatch[1].trim());
      } else {
        // 取标题第一部分作为对话对象
        const parts = title.split(/[\-—|·•:：]/).map((p) => p.trim()).filter(Boolean);
        if (parts.length > 0 && parts[0].length <= 20 && !chatApps.includes(parts[0])) {
          people.add(parts[0]);
        }
      }
    }

    // 模式2：邮件应用中的收件人
    if (segment.appName.includes("Outlook") || segment.appName.includes("Mail") || segment.appName.includes("邮件")) {
      const title = segment.windowTitle || "";
      // "Re: XXX" 或 "Fwd: XXX" 提取主题
      const reMatch = title.match(/(?:Re|Fwd|回复|转发):\s*(.+)/i);
      if (reMatch) {
        event = reMatch[1].trim().substring(0, 50);
      }
    }

    // 模式3：会议应用
    const meetingApps = ["Zoom", "腾讯会议", "Google Meet", "Webex", "会议"];
    if (meetingApps.some((app) => segment.appName.includes(app) || segment.windowTitle.includes(app))) {
      const title = segment.windowTitle || "";
      // 会议标题通常包含会议主题
      if (title.length > 4 && title.length < 60) {
        event = title.replace(/[-—|·•:：].*/, "").trim().substring(0, 50);
      }
    }

    // 模式4：从 OCR 文本中提取 @提及 的人名
    const mentionMatches = text.match(/@([^\s@,，。.!！?？:：]+)(?:\s|$)/g);
    if (mentionMatches) {
      for (const m of mentionMatches) {
        const name = m.replace(/^@/, "").trim();
        if (name.length >= 2 && name.length <= 20) {
          people.add(name);
        }
      }
    }

    // 模式5：从标题中提取事件（项目/文档名）
    if (!event) {
      const title = segment.userTitle || segment.windowTitle || "";
      // 文档类应用：提取文档名作为事件
      const docApps = ["Word", "Excel", "PowerPoint", "文档", "Notion", "Obsidian", "VS Code", "IDE"];
      if (docApps.some((app) => segment.appName.includes(app))) {
        const cleanTitle = title
          .replace(/[-—|·•:：].*/, "")
          .replace(/\.(docx?|xlsx?|pptx?|md|txt|ts|js|py|java)$/i, "")
          .trim();
        if (cleanTitle && cleanTitle.length >= 2 && cleanTitle.length <= 50) {
          event = cleanTitle;
        }
      }
    }

    // 模式6：从用户备注中提取
    if (segment.userNote) {
      const notePeopleMatch = segment.userNote.match(/(?:人|与|和|同事|客户|领导):\s*([^\n,，;；]+)/);
      if (notePeopleMatch) {
        for (const p of notePeopleMatch[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean)) {
          if (p.length <= 20) people.add(p);
        }
      }
      const noteEventMatch = segment.userNote.match(/(?:事|事件|项目|任务):\s*([^\n,，;；]+)/);
      if (noteEventMatch && !event) {
        event = noteEventMatch[1].trim().substring(0, 50);
      }
    }

    return {
      people: Array.from(people).slice(0, 10),
      event,
    };
  }

  /**
   * 批量提取并更新片段的人/事字段
   */
  async extractAndUpdateSegments(segments: WorkSegment[]): Promise<number> {
    const { segmentRepo } = await import("../database/repositories/segment-repo");
    let updated = 0;
    for (const segment of segments) {
      // 只对没有 people/event 的片段提取
      if ((!segment.people || segment.people.length === 0) && !segment.event) {
        const { people, event } = this.extractFromSegment(segment);
        if (people.length > 0 || event) {
          await segmentRepo.updateSegment(segment.id, { people, event });
          updated++;
        }
      }
    }
    return updated;
  }
}

export const entityExtractionService = new EntityExtractionService();
