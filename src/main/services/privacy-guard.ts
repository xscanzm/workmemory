import { privacyRepo } from "../database/repositories/privacy-repo";
import { WindowSnapshot } from "../../shared/types";

/**
 * PrivacyGuard - 隐私保护服务
 * 检查窗口是否命中隐私黑名单
 */
export class PrivacyGuard {
  /**
   * 检查窗口快照是否命中隐私规则
   */
  async isPrivate(snapshot: WindowSnapshot): Promise<boolean> {
    return privacyRepo.matchesAny(
      snapshot.appName,
      snapshot.processName,
      snapshot.windowTitle
    );
  }

  /**
   * 检查应用名是否命中
   */
  async isAppNamePrivate(appName: string): Promise<boolean> {
    return privacyRepo.matchesAny(appName, "", "");
  }

  /**
   * 检查窗口标题是否命中
   */
  async isWindowTitlePrivate(windowTitle: string): Promise<boolean> {
    return privacyRepo.matchesAny("", "", windowTitle);
  }
}

export const privacyGuard = new PrivacyGuard();