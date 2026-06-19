import { knowledgeRepo } from "../database/repositories/knowledge-repo";
import { segmentRepo } from "../database/repositories/segment-repo";
import { aiService } from "./ai";
import { KnowledgeNode } from "../../shared/types";

/**
 * WikiService - 知识库服务
 * 参考 llm_wiki 项目核心特性：
 * - Two-Step Chain-of-Thought Ingest（两步思维链提取）
 * - 双链 [[]] 语法解析
 * - 知识图谱构建
 *
 * 策略：优先 AI 提取，失败降级为规则提取
 */
export class WikiService {
  /**
   * 从工作片段中提取知识点
   * AI 策略：分析片段内容，提取可沉淀的知识点
   */
  async extractFromSegments(segmentIds: string[]): Promise<{ extracted: number; nodes: KnowledgeNode[] }> {
    const segments = [];
    for (const id of segmentIds) {
      const seg = await segmentRepo.getSegmentById(id);
      if (seg) segments.push(seg);
    }

    if (segments.length === 0) return { extracted: 0, nodes: [] };

    const nodes: KnowledgeNode[] = [];

    // 尝试 AI 提取
    try {
      const aiNodes = await this.extractByAi(segments);
      for (const nodeData of aiNodes) {
        // 检查是否已存在同名知识点
        const existing = await knowledgeRepo.getByTitle(nodeData.title);
        if (!existing) {
          const saved = await knowledgeRepo.save({
            title: nodeData.title,
            content: nodeData.content,
            summary: nodeData.summary,
            tags: nodeData.tags,
            source: "extracted",
            sourceSegmentIds: segmentIds,
          });
          nodes.push(saved);
        }
      }
    } catch (error) {
      console.warn("WikiService: AI 提取失败，降级为规则提取:", error);
      // 降级为规则提取
      const ruleNodes = this.extractByRule(segments);
      for (const nodeData of ruleNodes) {
        const existing = await knowledgeRepo.getByTitle(nodeData.title);
        if (!existing) {
          const saved = await knowledgeRepo.save({
            title: nodeData.title,
            content: nodeData.content,
            summary: nodeData.summary,
            tags: nodeData.tags,
            source: "extracted",
            sourceSegmentIds: segmentIds,
          });
          nodes.push(saved);
        }
      }
    }

    return { extracted: nodes.length, nodes };
  }

  /**
   * AI 提取知识点（Two-Step Chain-of-Thought）
   */
  private async extractByAi(segments: any[]): Promise<Array<{
    title: string;
    content: string;
    summary: string;
    tags: string[];
  }>> {
    const segmentsText = segments
      .slice(0, 10)
      .map((s, i) => {
        const time = s.startTime.split("T")[1]?.substring(0, 5) || "";
        return `[片段${i + 1}] ${time} ${s.appName} - ${s.userTitle || s.windowTitle}\n摘要: ${s.userSummary || s.ocrSummary || s.ocrText?.substring(0, 200) || ""}`;
      })
      .join("\n\n");

    const prompt = `请分析以下工作片段，提取可沉淀的知识点。

工作片段：
${segmentsText}

请用 JSON 数组格式输出知识点，每个知识点包含：
- title: 知识点标题（简洁，10-20字）
- content: 详细内容（Markdown 格式，可使用 [[其他知识点标题]] 创建双链，100-300字）
- summary: 一句话摘要（不超过30字）
- tags: 标签数组（2-5个）

要求：
1. 只提取有长期价值的知识，不要记录流水账
2. 内容要结构化，包含背景、要点、结论
3. 可以使用 [[]] 引用其他知识点标题建立双链
4. 只输出 JSON 数组，不要其他文字

示例：
[{"title":"React性能优化要点","content":"## 背景\\n在处理大型列表时...\\n## 要点\\n1. 虚拟滚动 [[虚拟滚动原理]]\\n2. useMemo 缓存","summary":"React大列表性能优化方案","tags":["React","性能","前端"]}]`;

    const result = await aiService.generateReport(prompt);
    if (result.error || !result.content) {
      throw new Error(result.error || "AI 返回空内容");
    }

    // 解析 JSON
    const content = result.content.trim();
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("AI 返回格式不正确");

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error("AI 返回非数组");

    return parsed.filter((item: any) => item.title && item.content);
  }

  /**
   * 规则提取降级方案
   * 从片段标题和摘要中提取主题知识点
   */
  private extractByRule(segments: any[]): Array<{
    title: string;
    content: string;
    summary: string;
    tags: string[];
  }> {
    const nodes: Array<{ title: string; content: string; summary: string; tags: string[] }> = [];

    // 按应用分组
    const appGroups = new Map<string, any[]>();
    for (const s of segments) {
      const app = s.appName;
      if (!appGroups.has(app)) appGroups.set(app, []);
      appGroups.get(app)!.push(s);
    }

    for (const [app, segs] of appGroups) {
      // 只对有足够内容的片段提取
      const meaningfulSegs = segs.filter((s) => s.userSummary || s.ocrSummary || (s.ocrText && s.ocrText.length > 50));
      if (meaningfulSegs.length === 0) continue;

      // 提取标题：取第一个有意义的标题
      const firstTitle = meaningfulSegs[0].userTitle || meaningfulSegs[0].windowTitle || "";
      const cleanTitle = firstTitle.replace(/[-—|·•:：].*/, "").trim();
      if (!cleanTitle || cleanTitle.length < 2) continue;

      const title = `${cleanTitle}（${app}）`.substring(0, 40);

      // 构建内容
      const contentParts: string[] = [`## ${cleanTitle}\n`];
      contentParts.push(`**应用**: ${app}\n`);
      contentParts.push(`**涉及时间**: ${meaningfulSegs.map((s) => s.startTime.split("T")[1]?.substring(0, 5)).join(", ")}\n`);

      const summaries = meaningfulSegs
        .map((s) => s.userSummary || s.ocrSummary)
        .filter(Boolean)
        .slice(0, 5);
      if (summaries.length > 0) {
        contentParts.push(`\n## 要点\n`);
        for (const sum of summaries) {
          contentParts.push(`- ${sum}\n`);
        }
      }

      const content = contentParts.join("");
      const summary = `${app}中关于${cleanTitle}的工作记录`.substring(0, 30);
      const tags = [app, "工作记录"];

      nodes.push({ title, content, summary, tags });
    }

    return nodes;
  }

  /**
   * 渲染双链：将 [[标题]] 转换为可点击的链接
   */
  renderDoubleLinks(content: string, existingTitles: string[] = []): string {
    return content.replace(/\[\[([^\]]+)\]\]/g, (match, title) => {
      const exists = existingTitles.includes(title.trim());
      const cls = exists ? "wiki-link" : "wiki-link-missing";
      return `<a class="${cls}" data-wiki-title="${title.trim()}" href="#">${title.trim()}</a>`;
    });
  }

  /**
   * 提取内容中的所有双链标题
   */
  extractDoubleLinkTitles(content: string): string[] {
    const titles: string[] = [];
    const regex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      titles.push(match[1].trim());
    }
    return titles;
  }
}

export const wikiService = new WikiService();
