import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../shared/types";
import { segmentRepo } from "./database/repositories/segment-repo";
import { configRepo } from "./database/repositories/config-repo";
import { privacyRepo } from "./database/repositories/privacy-repo";
import { aiConfigRepo } from "./database/repositories/ai-config-repo";
import { templateRepo } from "./database/repositories/template-repo";
import { reportRepo } from "./database/repositories/report-repo";
import { eventLogRepo } from "./database/repositories/event-log-repo";
import { dailySummaryRepo } from "./database/repositories/daily-summary-repo";
import { dailySummaryService } from "./services/daily-summary-service";
import { recorderService } from "./services/recorder";
import { aiService } from "./services/ai";
import { exportService } from "./services/export";
import { knowledgeRepo } from "./database/repositories/knowledge-repo";
import { wikiService } from "./services/wiki-service";
import { insightsRepo } from "./database/repositories/insights-repo";
import { insightsService } from "./services/insights-service";
import { entityExtractionService } from "./services/entity-extraction";
import { app } from "electron";

export function registerIpcHandlers(): void {
  // ==========================================
  // Recorder
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_RECORDER_STATUS, () => {
    return recorderService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SET_RECORDER_STATUS, (_event, status: string) => {
    recorderService.setStatus(status as any);
    return recorderService.getStatus();
  });

  // ==========================================
  // Segments
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_SEGMENTS, async (_event, date: string) => {
    return segmentRepo.getTodaySegments(date);
  });

  ipcMain.handle(IPC_CHANNELS.GET_SEGMENT, async (_event, id: string) => {
    return segmentRepo.getSegmentById(id);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_SEGMENT, async (_event, id: string, updates: any) => {
    await segmentRepo.updateSegment(id, updates);
    return segmentRepo.getSegmentById(id);
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_SEGMENT, async (_event, id: string) => {
    await segmentRepo.softDeleteSegment(id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.TOGGLE_SEGMENT_SELECTION, async (_event, id: string) => {
    const segment = await segmentRepo.getSegmentById(id);
    if (segment) {
      await segmentRepo.updateSegment(id, { isSelectedForReport: !segment.isSelectedForReport });
    }
    return segmentRepo.getSegmentById(id);
  });

  ipcMain.handle(IPC_CHANNELS.CLEAR_TODAY, async (_event, date: string) => {
    await segmentRepo.clearToday(date);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.CLEAR_ALL, async () => {
    await segmentRepo.clearAll();
    return true;
  });

  // ==========================================
  // Config
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_APP_CONFIG, async () => {
    return configRepo.getConfig();
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_APP_CONFIG, async (_event, config: any) => {
    await configRepo.saveConfig(config);
    return configRepo.getConfig();
  });

  // ==========================================
  // Privacy
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_PRIVACY_RULES, async () => {
    return privacyRepo.getAll();
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_PRIVACY_RULE, async (_event, rule: any) => {
    return privacyRepo.save(rule);
  });

  ipcMain.handle(
    IPC_CHANNELS.UPDATE_PRIVACY_RULE,
    async (_event, id: string, updates: any) => {
      await privacyRepo.update(id, updates);
      return privacyRepo.getAll();
    }
  );

  ipcMain.handle(IPC_CHANNELS.DELETE_PRIVACY_RULE, async (_event, id: string) => {
    await privacyRepo.delete(id);
    return true;
  });

  // ==========================================
  // AI Config
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_AI_CONFIGS, async () => {
    return aiConfigRepo.getAll();
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_AI_CONFIG, async (_event, config: any) => {
    return aiConfigRepo.save(config);
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_AI_CONFIG, async (_event, id: string) => {
    await aiConfigRepo.delete(id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.TEST_AI_CONNECTION, async (_event, configId?: string) => {
    return aiService.testConnection(configId);
  });

  ipcMain.handle(
    IPC_CHANNELS.GENERATE_REPORT,
    async (_event, params: { date: string; templateId: string; userNotes?: string }) => {
      const built = await aiService.buildAiInput(params.date, params.templateId, params.userNotes);
      if (!built) {
        return { error: "模板未找到" };
      }

      const result = await aiService.generateReport(built.promptRendered);
      if (result.error) {
        return { error: result.error };
      }

      // 保存日报到数据库（PRD 8 节 reports 表）
      const template = await templateRepo.getById(params.templateId);

      // 获取实际选中的片段 ID
      const todaySegments = await segmentRepo.getTodaySegments(params.date);
      const selectedSegmentIds = todaySegments
        .filter((s) => s.isSelectedForReport && !s.isDeleted)
        .map((s) => s.id);

      const savedReport = await reportRepo.save({
        date: params.date,
        templateId: params.templateId,
        templateName: template?.name || "",
        segmentIds: selectedSegmentIds,
        userNotes: params.userNotes,
        promptSnapshot: built.promptRendered,
        aiInputSnapshot: JSON.stringify(built.input),
        markdownContent: result.content,
        status: "generated",
      });

      await eventLogRepo.info("ai", "日报已生成并保存", `reportId=${savedReport.id}`);

      return {
        content: result.content,
        reportId: savedReport.id,
        inputSnapshot: JSON.stringify(built.input),
        segments: built.segments,
      };
    }
  );

  // ==========================================
  // Templates
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_TEMPLATES, async () => {
    return templateRepo.getAll();
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_TEMPLATE, async (_event, template: any) => {
    return templateRepo.save(template);
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_TEMPLATE, async (_event, id: string) => {
    await templateRepo.delete(id);
    return true;
  });

  // ==========================================
  // Reports
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_REPORTS, async () => {
    return reportRepo.getAll();
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_REPORT, async (_event, report: any) => {
    // 如果有 id，则更新已有日报；否则新建
    if (report.id) {
      await reportRepo.update(report.id, {
        markdownContent: report.markdownContent,
        richTextContent: report.richTextContent,
        status: report.status,
      });
      return reportRepo.getById(report.id);
    }
    return reportRepo.save(report);
  });

  ipcMain.handle(
    IPC_CHANNELS.EXPORT_MARKDOWN,
    async (_event, content: string, defaultFilename: string) => {
      return exportService.exportMarkdown(content, defaultFilename);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.EXPORT_WORD,
    async (_event, htmlContent: string, defaultFilename: string) => {
      return exportService.exportWord(htmlContent, defaultFilename);
    }
  );

  ipcMain.handle(IPC_CHANNELS.COPY_RICH_TEXT, (_event, markdown: string) => {
    return exportService.markdownToHtml(markdown);
  });

  // ==========================================
  // App
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.QUIT_APP, () => {
    app.quit();
    return true;
  });

  // ==========================================
  // Calendar & Daily Summary
  // ==========================================
  ipcMain.handle(
    IPC_CHANNELS.GET_CALENDAR_MONTH,
    async (_event, year: number, month: number) => {
      return dailySummaryRepo.getCalendarMonth(year, month);
    }
  );

  ipcMain.handle(IPC_CHANNELS.GET_DAILY_SUMMARY, async (_event, date: string) => {
    return dailySummaryRepo.getByDate(date);
  });

  ipcMain.handle(
    IPC_CHANNELS.GENERATE_DAILY_SUMMARY,
    async (_event, date: string, force?: boolean) => {
      return dailySummaryService.generate(date, force || false);
    }
  );

  ipcMain.handle(IPC_CHANNELS.GET_SEGMENTS_BY_DATE, async (_event, date: string) => {
    return segmentRepo.getTodaySegments(date);
  });

  // ==========================================
  // Search
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.SEARCH_SEGMENTS, async (_event, query: string) => {
    if (!query || query.trim().length === 0) return [];
    return segmentRepo.search(query.trim());
  });

  // ==========================================
  // Stats
  // ==========================================
  ipcMain.handle(
    IPC_CHANNELS.GET_WORK_STATS,
    async (_event, startDate: string, endDate: string) => {
      return segmentRepo.getWorkStats(startDate, endDate);
    }
  );

  // ==========================================
  // Export Date Range
  // ==========================================
  ipcMain.handle(
    IPC_CHANNELS.EXPORT_DATE_RANGE,
    async (_event, startDate: string, endDate: string, format: "markdown" | "json") => {
      const segments = await segmentRepo.getByDateRange(startDate, endDate);

      if (format === "json") {
        const data = JSON.stringify(segments, null, 2);
        const { dialog } = require("electron");
        const result = await dialog.showSaveDialog({
          defaultPath: `workmemory_${startDate}_${endDate}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) {
          return { success: false, error: "已取消" };
        }
        const fs = require("fs");
        fs.writeFileSync(result.filePath, data, "utf-8");
        return { success: true, filePath: result.filePath };
      }

      // markdown 格式
      const groupedByDate = new Map<string, typeof segments>();
      for (const s of segments) {
        if (!groupedByDate.has(s.date)) groupedByDate.set(s.date, []);
        groupedByDate.get(s.date)!.push(s);
      }

      let md = `# 工作记忆 ${startDate} ~ ${endDate}\n\n`;
      for (const [date, daySegments] of groupedByDate) {
        const totalMin = Math.round(
          daySegments.reduce((sum, s) => sum + s.durationSeconds, 0) / 60
        );
        md += `## ${date}（共 ${totalMin} 分钟，${daySegments.length} 个片段）\n\n`;
        for (const s of daySegments) {
          const start = s.startTime.split("T")[1]?.substring(0, 5) || "";
          const end = s.endTime.split("T")[1]?.substring(0, 5) || "";
          const dur = Math.round(s.durationSeconds / 60);
          md += `### ${start}-${end}（${dur}分钟）${s.userTitle || s.windowTitle}\n`;
          md += `- 应用：${s.appName}\n`;
          if (s.userSummary || s.ocrSummary) {
            md += `- 摘要：${s.userSummary || s.ocrSummary}\n`;
          }
          if (s.userNote) md += `- 备注：${s.userNote}\n`;
          if (s.tags.length > 0) md += `- 标签：${s.tags.join(", ")}\n`;
          md += `\n`;
        }
      }

      const { dialog } = require("electron");
      const result = await dialog.showSaveDialog({
        defaultPath: `workmemory_${startDate}_${endDate}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: "已取消" };
      }
      const fs = require("fs");
      fs.writeFileSync(result.filePath, md, "utf-8");
      return { success: true, filePath: result.filePath };
    }
  );

  // ==========================================
  // Memory Graph (人/事/时间串联)
  // ==========================================
  ipcMain.handle(
    IPC_CHANNELS.GET_MEMORY_GRAPH,
    async (_event, startDate?: string, endDate?: string) => {
      return segmentRepo.getMemoryGraph(startDate, endDate);
    }
  );

  ipcMain.handle(IPC_CHANNELS.GET_SEGMENTS_BY_PERSON, async (_event, person: string) => {
    return segmentRepo.getSegmentsByPerson(person);
  });

  ipcMain.handle(IPC_CHANNELS.GET_SEGMENTS_BY_EVENT, async (_event, event: string) => {
    return segmentRepo.getSegmentsByEvent(event);
  });

  ipcMain.handle(
    IPC_CHANNELS.UPDATE_SEGMENT_PEOPLE_EVENT,
    async (_event, id: string, people: string[], event?: string) => {
      await segmentRepo.updateSegment(id, { people, event });
      return segmentRepo.getSegmentById(id);
    }
  );

  // ==========================================
  // Wiki Knowledge Base (知识库双链)
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.WIKI_GET_NODES, async () => {
    return knowledgeRepo.getAll();
  });

  ipcMain.handle(IPC_CHANNELS.WIKI_GET_NODE, async (_event, id: string) => {
    return knowledgeRepo.getById(id);
  });

  ipcMain.handle(IPC_CHANNELS.WIKI_SAVE_NODE, async (_event, node: any) => {
    return knowledgeRepo.save(node);
  });

  ipcMain.handle(IPC_CHANNELS.WIKI_DELETE_NODE, async (_event, id: string) => {
    await knowledgeRepo.delete(id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.WIKI_SEARCH, async (_event, query: string) => {
    if (!query || query.trim().length === 0) return knowledgeRepo.getAll();
    return knowledgeRepo.search(query.trim());
  });

  ipcMain.handle(IPC_CHANNELS.WIKI_GET_LINKS, async (_event, nodeId: string) => {
    return knowledgeRepo.getLinks(nodeId);
  });

  ipcMain.handle(IPC_CHANNELS.WIKI_GET_GRAPH, async () => {
    return knowledgeRepo.getGraph();
  });

  ipcMain.handle(IPC_CHANNELS.WIKI_EXTRACT_FROM_SEGMENTS, async (_event, segmentIds: string[]) => {
    return wikiService.extractFromSegments(segmentIds);
  });

  // ==========================================
  // Proactive Intelligence (主动智能)
  // ==========================================
  ipcMain.handle(IPC_CHANNELS.INSIGHTS_GET, async (_event, includeDismissed?: boolean) => {
    return insightsRepo.getInsights(includeDismissed || false);
  });

  ipcMain.handle(IPC_CHANNELS.INSIGHTS_DISMISS, async (_event, id: string) => {
    await insightsRepo.dismissInsight(id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.INSIGHTS_GET_REMINDERS, async (_event, includeDismissed?: boolean) => {
    return insightsRepo.getReminders(includeDismissed || false);
  });

  ipcMain.handle(IPC_CHANNELS.INSIGHTS_DISMISS_REMINDER, async (_event, id: string) => {
    await insightsRepo.dismissReminder(id);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.INSIGHTS_GET_ANOMALIES, async (_event, includeDismissed?: boolean) => {
    return insightsRepo.getAnomalies(includeDismissed || false);
  });

  ipcMain.handle(IPC_CHANNELS.INSIGHTS_REFRESH, async () => {
    return insightsService.refresh();
  });

  // Forward recorder status changes to renderer
  recorderService.onStatusChange((status) => {
    const { getMainWindow } = require("./window");
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.ON_RECORDER_STATUS_CHANGE, status);
    }
  });
}