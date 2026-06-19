import { insightsRepo } from "../database/repositories/insights-repo";
import { segmentRepo } from "../database/repositories/segment-repo";
import { configRepo } from "../database/repositories/config-repo";
import { InsightCard, InsightType, InsightSeverity, SmartReminder, AnomalyDetection } from "../../shared/types";

/**
 * InsightsService - 主动智能服务
 * 1. 洞察生成：分析工作模式，生成洞察卡片
 * 2. 智能提醒：基于时间/状态生成提醒
 * 3. 异常检测：检测异常工作模式
 */
export class InsightsService {
  /**
   * 刷新洞察：分析最近7天数据，生成新洞察
   */
  async refresh(): Promise<{ insights: number; anomalies: number }> {
    const config = await configRepo.getConfig();
    const today = new Date();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(today.getDate() - 7);
    const startDate = sevenDaysAgo.toISOString().split("T")[0];
    const endDate = today.toISOString().split("T")[0];

    const stats = await segmentRepo.getWorkStats(startDate, endDate);
    let insightCount = 0;
    let anomalyCount = 0;

    // === 生成洞察 ===
    if (config.insightsEnabled) {
      insightCount += await this.generateWorkPatternInsights(stats);
      insightCount += await this.generateAppUsageInsights(stats);
      insightCount += await this.generateProductivityInsights(stats);
      insightCount += await this.generateComparisonInsights(stats);
    }

    // === 异常检测 ===
    if (config.anomalyDetectionEnabled) {
      anomalyCount += await this.detectAnomalies(stats);
    }

    // === 智能提醒 ===
    if (config.smartReminderEnabled) {
      await this.generateSmartReminders();
    }

    return { insights: insightCount, anomalies: anomalyCount };
  }

  /**
   * 工作模式洞察：分析时段分布
   */
  private async generateWorkPatternInsights(stats: any): Promise<number> {
    let count = 0;
    const hourly = stats.hourlyDistribution;
    const totalSeconds = hourly.reduce((a: number, b: number) => a + b, 0);
    if (totalSeconds === 0) return 0;

    // 找出最高效时段
    let peakHour = 0;
    let peakDuration = 0;
    for (let h = 0; h < 24; h++) {
      if (hourly[h] > peakDuration) {
        peakDuration = hourly[h];
        peakHour = h;
      }
    }
    const peakPercentage = Math.round((peakDuration / totalSeconds) * 100);

    if (peakPercentage > 25) {
      await insightsRepo.saveInsight({
        type: "work_pattern" as InsightType,
        severity: "positive" as InsightSeverity,
        title: "你的高效时段",
        content: `最近7天，你在 ${peakHour}:00-${peakHour + 1}:00 时段最为活跃，占全部工作时长的 ${peakPercentage}%。建议将重要任务安排在这个时段。`,
        actionLabel: "查看洞察",
        actionRoute: "/insights",
        metadata: { peakHour, peakPercentage },
      });
      count++;
    }

    // 检查深夜工作
    const lateNightSeconds = (hourly[22] || 0) + (hourly[23] || 0) + (hourly[0] || 0) + (hourly[1] || 0);
    if (lateNightSeconds > 3600 * 2) {
      await insightsRepo.saveInsight({
        type: "time_anomaly" as InsightType,
        severity: "warning" as InsightSeverity,
        title: "深夜工作较多",
        content: `最近7天，你在 22:00-2:00 时段工作了约 ${Math.round(lateNightSeconds / 3600)} 小时。长期深夜工作会影响效率，建议调整作息。`,
        actionLabel: "查看详情",
        actionRoute: "/insights",
        metadata: { lateNightSeconds },
      });
      count++;
    }

    return count;
  }

  /**
   * 应用使用洞察
   */
  private async generateAppUsageInsights(stats: any): Promise<number> {
    let count = 0;
    if (stats.appDistribution.length === 0) return 0;

    const topApp = stats.appDistribution[0];
    if (topApp.percentage > 50) {
      await insightsRepo.saveInsight({
        type: "app_usage" as InsightType,
        severity: "info" as InsightSeverity,
        title: "应用使用集中",
        content: `${topApp.app} 占了你最近7天 ${Math.round(topApp.percentage)}% 的工作时间。如果这是核心工作工具，说明你很专注；如果不是，可能需要减少分心。`,
        actionLabel: "查看洞察",
        actionRoute: "/insights",
        metadata: { app: topApp.app, percentage: topApp.percentage },
      });
      count++;
    }

    // 检查多任务切换
    if (stats.totalSegments > 100 && stats.appDistribution.length > 8) {
      await insightsRepo.saveInsight({
        type: "app_usage" as InsightType,
        severity: "warning" as InsightSeverity,
        title: "应用切换频繁",
        content: `最近7天你使用了 ${stats.appDistribution.length} 个应用，产生了 ${stats.totalSegments} 个工作片段。频繁切换应用会降低专注度，建议尝试番茄工作法。`,
        actionLabel: "查看洞察",
        actionRoute: "/insights",
        metadata: { appCount: stats.appDistribution.length, segmentCount: stats.totalSegments },
      });
      count++;
    }

    return count;
  }

  /**
   * 生产力建议
   */
  private async generateProductivityInsights(stats: any): Promise<number> {
    let count = 0;
    const totalHours = stats.totalDurationSeconds / 3600;

    if (totalHours > 0) {
      // 平均每日工作时长
      const dailyAvg = totalHours / 7;

      if (dailyAvg > 10) {
        await insightsRepo.saveInsight({
          type: "productivity" as InsightType,
          severity: "warning" as InsightSeverity,
          title: "工作时长偏长",
          content: `最近7天平均每天工作 ${Math.round(dailyAvg)} 小时。长时间工作可能导致疲劳和效率下降，建议适当休息。`,
          actionLabel: "查看日报",
          actionRoute: "/report",
          metadata: { dailyAvg },
        });
        count++;
      } else if (dailyAvg > 0 && dailyAvg < 3 && stats.totalSegments > 5) {
        await insightsRepo.saveInsight({
          type: "productivity" as InsightType,
          severity: "info" as InsightSeverity,
          title: "工作时长较短",
          content: `最近7天平均每天工作 ${Math.round(dailyAvg)} 小时。如果这是预期的工作节奏，很好；如果需要提升产出，可以尝试规划每日重点任务。`,
          actionLabel: "生成日报",
          actionRoute: "/report",
          metadata: { dailyAvg },
        });
        count++;
      }
    }

    return count;
  }

  /**
   * 对比洞察（与前一周对比）
   */
  private async generateComparisonInsights(stats: any): Promise<number> {
    let count = 0;
    if (stats.dailyTrend.length < 4) return 0;

    // 计算前半段和后半段平均
    const mid = Math.floor(stats.dailyTrend.length / 2);
    const firstHalf = stats.dailyTrend.slice(0, mid);
    const secondHalf = stats.dailyTrend.slice(mid);

    const firstAvg = firstHalf.reduce((sum: number, d: any) => sum + d.durationSeconds, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum: number, d: any) => sum + d.durationSeconds, 0) / secondHalf.length;

    if (firstAvg > 0 && secondAvg > 0) {
      const change = ((secondAvg - firstAvg) / firstAvg) * 100;
      if (Math.abs(change) > 20) {
        const isIncrease = change > 0;
        await insightsRepo.saveInsight({
          type: "comparison" as InsightType,
          severity: isIncrease ? "info" : "positive",
          title: isIncrease ? "工作时长上升" : "工作时长下降",
          content: `最近${secondHalf.length}天相比之前${firstHalf.length}天，平均每日工作时长${isIncrease ? "增加" : "减少"}了 ${Math.abs(Math.round(change))}%。`,
          actionLabel: "查看趋势",
          actionRoute: "/insights",
          metadata: { change, firstAvg, secondAvg },
        });
        count++;
      }
    }

    return count;
  }

  /**
   * 异常检测
   */
  private async detectAnomalies(stats: any): Promise<number> {
    let count = 0;

    // 检测异常应用使用（某个应用突然占用大量时间）
    if (stats.appDistribution.length > 0) {
      const topApp = stats.appDistribution[0];
      if (topApp.percentage > 60 && topApp.durationSeconds > 3600 * 10) {
        await insightsRepo.saveAnomaly({
          type: "unusual_app",
          title: "单一应用使用时间异常",
          description: `${topApp.app} 占用了 ${Math.round(topApp.percentage)}% 的工作时间（约 ${Math.round(topApp.durationSeconds / 3600)} 小时），请确认这是预期的工作内容。`,
          detectedAt: new Date().toISOString(),
          severity: "medium",
          metadata: { app: topApp.app, percentage: topApp.percentage },
        });
        count++;
      }
    }

    // 检测异常时段（凌晨工作）
    const hourly = stats.hourlyDistribution;
    const earlyMorningSeconds = (hourly[2] || 0) + (hourly[3] || 0) + (hourly[4] || 0);
    if (earlyMorningSeconds > 3600 * 3) {
      await insightsRepo.saveAnomaly({
        type: "unusual_time",
        title: "凌晨时段工作异常",
        description: `检测到在 2:00-5:00 凌晨时段工作了约 ${Math.round(earlyMorningSeconds / 3600)} 小时。这可能影响健康，建议调整工作安排。`,
        detectedAt: new Date().toISOString(),
        severity: "high",
        metadata: { earlyMorningSeconds },
      });
      count++;
    }

    return count;
  }

  /**
   * 生成智能提醒
   */
  private async generateSmartReminders(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    const today = now.toISOString().split("T")[0];

    // 每日总结提醒（下午6点）
    if (hour >= 18 && hour < 20) {
      const existing = await insightsRepo.getReminders();
      const hasDailyReminder = existing.some(
        (r) => r.type === "daily_summary" && r.scheduledAt.startsWith(today)
      );
      if (!hasDailyReminder) {
        await insightsRepo.saveReminder({
          type: "daily_summary",
          title: "今日工作总结",
          message: "今天的工作快结束了，要不要生成一份日报总结今天的工作？",
          scheduledAt: now.toISOString(),
          metadata: { date: today },
        });
      }
    }

    // 下班提醒（下午6点后如果还在工作）
    if (hour >= 19) {
      const todaySegments = await segmentRepo.getTodaySegments(today);
      const recentActivity = todaySegments.filter((s) => {
        const segTime = new Date(s.endTime);
        return segTime.getHours() >= 19;
      });
      if (recentActivity.length > 3) {
        const existing = await insightsRepo.getReminders();
        const hasEndOfDay = existing.some(
          (r) => r.type === "end_of_day" && r.scheduledAt.startsWith(today)
        );
        if (!hasEndOfDay) {
          await insightsRepo.saveReminder({
            type: "end_of_day",
            title: "该下班了",
            message: `已经 ${hour} 点了，今天已经工作很久了。注意休息，明天会更好。`,
            scheduledAt: now.toISOString(),
            metadata: { hour, recentCount: recentActivity.length },
          });
        }
      }
    }

    // 长时间会话提醒
    const todaySegments = await segmentRepo.getTodaySegments(today);
    for (const seg of todaySegments) {
      if (seg.durationSeconds > 3600 * 2 && !seg.isDeleted) {
        const existing = await insightsRepo.getReminders();
        const hasLongSession = existing.some(
          (r) => r.type === "long_session" && r.metadata?.segmentId === seg.id
        );
        if (!hasLongSession) {
          await insightsRepo.saveReminder({
            type: "long_session",
            title: "长时间连续工作",
            message: `你在 ${seg.appName} 上已经连续工作了 ${Math.round(seg.durationSeconds / 3600)} 小时。建议起身活动一下。`,
            scheduledAt: now.toISOString(),
            metadata: { segmentId: seg.id, appName: seg.appName },
          });
        }
        break; // 只提醒一次
      }
    }

    // 周报提醒（周五下午）
    if (now.getDay() === 5 && hour >= 16 && hour < 18) {
      const existing = await insightsRepo.getReminders();
      const weekKey = `${now.getFullYear()}-${Math.ceil((now.getDate() + 6 - now.getDay()) / 7)}`;
      const hasWeekly = existing.some(
        (r) => r.type === "weekly_review" && r.metadata?.weekKey === weekKey
      );
      if (!hasWeekly) {
        await insightsRepo.saveReminder({
          type: "weekly_review",
          title: "周报时间",
          message: "本周工作即将结束，要不要回顾一下这周的工作，生成周报？",
          scheduledAt: now.toISOString(),
          metadata: { weekKey },
        });
      }
    }
  }
}

export const insightsService = new InsightsService();
