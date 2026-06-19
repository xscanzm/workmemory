import { segmentRepo } from "../database/repositories/segment-repo";
import { configRepo } from "../database/repositories/config-repo";
import { WorkSegment, WindowSnapshot } from "../../shared/types";

/**
 * SegmentMerger - 片段去重与合并
 * 判断新窗口快照是否可以合并到上一个片段
 */
export class SegmentMerger {
  /**
   * 判断是否可以延长上一个片段
   * 检查：应用相同 + 标题相似 + 未超过最大片段时长
   */
  async canExtendSegment(previous: WorkSegment, current: WindowSnapshot): Promise<boolean> {
    // 应用不同，不能合并
    if (previous.appName !== current.appName) return false;

    // 检查最大片段时长阈值（PRD 7.3 节）
    const config = await configRepo.getConfig();
    const maxDurationMs = config.maxSegmentDurationMinutes * 60 * 1000;
    const segmentDuration = Date.now() - new Date(previous.startTime).getTime();
    if (segmentDuration >= maxDurationMs) return false;

    // 窗口标题相同，可以合并
    if (previous.windowTitle === current.windowTitle) return true;

    // 标题相似度检查（简单包含关系）
    const prevTitle = previous.windowTitle.toLowerCase();
    const currTitle = current.windowTitle.toLowerCase();
    if (prevTitle.includes(currTitle) || currTitle.includes(prevTitle)) {
      return true;
    }

    return false;
  }

  /**
   * 延长片段结束时间
   */
  async extendSegment(segmentId: string): Promise<void> {
    await segmentRepo.extendSegmentEndTime(segmentId, new Date().toISOString());
  }

  /**
   * 创建新片段
   */
  async createSegment(snapshot: WindowSnapshot): Promise<WorkSegment> {
    const today = new Date().toISOString().split("T")[0];

    const segment = await segmentRepo.createSegment({
      date: today,
      startTime: snapshot.capturedAt,
      endTime: snapshot.capturedAt,
      durationSeconds: 0,
      appName: snapshot.appName,
      processName: snapshot.processName,
      windowTitle: snapshot.windowTitle,
      isSelectedForReport: true,
      isPrivate: false,
      isImportant: false,
      isDeleted: false,
      sourceStatus: "pending",
      screenshotSaved: false,
      tags: [],
    });

    return segment;
  }

  /**
   * 创建隐私占位片段
   */
  async createPrivateSegment(): Promise<WorkSegment> {
    const today = new Date().toISOString().split("T")[0];
    const now = new Date().toISOString();

    const segment = await segmentRepo.createSegment({
      date: today,
      startTime: now,
      endTime: now,
      durationSeconds: 0,
      appName: "隐私窗口",
      processName: "private",
      windowTitle: "隐私窗口",
      isSelectedForReport: false,
      isPrivate: true,
      isImportant: false,
      isDeleted: false,
      sourceStatus: "private",
      screenshotSaved: false,
      tags: [],
    });

    return segment;
  }
}

export const segmentMerger = new SegmentMerger();