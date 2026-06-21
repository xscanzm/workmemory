/**
 * PrivacyGuard：隐私防护中心
 *
 * 功能：
 *  - check(windowInfo)：调用 PrivacyRuleRepository.matchRule 判断 skip/placeholder/allow
 *  - detectIncognito(windowInfo)：检测无痕浏览窗口
 *  - onIncognitoDetected：触发桌面伙伴遮眼拉帘 + 系统切入隐私模式
 *  - seedDefaultRules()：首次启动 seed 内置默认规则
 *
 * 硬约束（代码审计点）：
 *  本模块绝不引入任何键盘钩子（不 require keyboard/iohook/globalShortcut 监听按键），
 *  仅处理窗口标题、进程名等宏观信息。本文件中无任何键盘捕获代码。
 */
import { EventEmitter } from 'node:events'
import type { PrivacyAction, PrivacyMatchResult, PrivacyRule } from '@/types'
import { PrivacyRuleRepository } from '../db/repositories/PrivacyRuleRepository'
import { IncognitoDetector } from './IncognitoDetector'
import type { WindowInfo } from './WindowWatcher'

/** PrivacyGuard 检查结果 */
export interface PrivacyCheckResult {
  action: PrivacyAction
  reason: string
  matchedRule: PrivacyRule | null
}

/** 默认隐私规则种子数据 */
interface DefaultRuleSeed {
  type: PrivacyRule['type']
  pattern: string
  matchMode: PrivacyRule['matchMode']
}

/** 内置默认规则：首次启动 seed 到 privacy_rules 表 */
const DEFAULT_RULES: DefaultRuleSeed[] = [
  // 进程级 skip：密码管理器
  { type: 'process_name', pattern: 'KeePass.exe', matchMode: 'equals' },
  { type: 'process_name', pattern: 'Bitwarden.exe', matchMode: 'equals' },
  { type: 'process_name', pattern: '1Password.exe', matchMode: 'equals' },
  { type: 'process_name', pattern: 'LastPass.exe', matchMode: 'equals' },
  // 窗口标题 placeholder：敏感关键词
  { type: 'window_title', pattern: '银行', matchMode: 'contains' },
  { type: 'window_title', pattern: '网银', matchMode: 'contains' },
  { type: 'window_title', pattern: '密码', matchMode: 'contains' },
  { type: 'window_title', pattern: '支付', matchMode: 'contains' },
  { type: 'window_title', pattern: '身份证', matchMode: 'contains' },
  { type: 'window_title', pattern: '医疗', matchMode: 'contains' },
  { type: 'window_title', pattern: '无痕模式', matchMode: 'contains' },
  { type: 'window_title', pattern: 'Incognito', matchMode: 'contains' },
  { type: 'window_title', pattern: 'InPrivate', matchMode: 'contains' },
  { type: 'window_title', pattern: 'Private', matchMode: 'contains' },
  { type: 'window_title', pattern: '登录', matchMode: 'contains' },
  { type: 'window_title', pattern: '账户', matchMode: 'contains' }
]

/**
 * PrivacyGuard：隐私防护中心。
 *
 * 事件：
 *  - 'incognito-detected'：检测到无痕窗口，携带 WindowInfo
 *  - 'incognito-cleared'：离开无痕窗口
 *  - 'privacy-mode-entered'：系统切入隐私模式
 *  - 'privacy-mode-exited'：系统退出隐私模式
 */
export class PrivacyGuard extends EventEmitter {
  private incognitoDetector: IncognitoDetector
  private privacyMode = false

  constructor() {
    super()
    this.incognitoDetector = new IncognitoDetector()
    // 转发无痕检测器事件
    this.incognitoDetector.on('incognito-detected', (info: WindowInfo) => {
      this.onIncognitoDetected(info)
    })
    this.incognitoDetector.on('incognito-cleared', (info: WindowInfo) => {
      this.onIncognitoCleared(info)
    })
  }

  /**
   * 隐私检查：调用 PrivacyRuleRepository.matchRule 判断动作。
   * 返回 { action, reason, matchedRule }。
   */
  check(windowInfo: WindowInfo): PrivacyCheckResult {
    const result: PrivacyMatchResult = PrivacyRuleRepository.matchRule(
      windowInfo.appName,
      windowInfo.processName,
      windowInfo.windowTitle,
      '' // URL 暂不采集，传入空字符串
    )
    const reason = result.matchedRule
      ? `命中${result.matchedRule.type}规则: ${result.matchedRule.pattern}`
      : '未命中隐私规则'
    return {
      action: result.action,
      reason,
      matchedRule: result.matchedRule
    }
  }

  /**
   * 检测窗口是否为无痕浏览窗口。
   * 委托给 IncognitoDetector.detect。
   */
  detectIncognito(windowInfo: WindowInfo): boolean {
    return this.incognitoDetector.detect(windowInfo)
  }

  /** 获取无痕检测器实例（供 CaptureManager 订阅 WindowWatcher） */
  getIncognitoDetector(): IncognitoDetector {
    return this.incognitoDetector
  }

  /** 当前是否处于隐私模式 */
  isPrivacyMode(): boolean {
    return this.privacyMode
  }

  /**
   * 无痕窗口检测回调：
   *  1. 触发桌面伙伴遮眼拉帘动作（emit 事件，由 CaptureManager 广播 IPC）
   *  2. 系统切入隐私模式
   */
  private onIncognitoDetected(info: WindowInfo): void {
    this.privacyMode = true
    this.emit('incognito-detected', info)
    this.emit('privacy-mode-entered', info)
    console.warn(`[PrivacyGuard] 检测到无痕浏览窗口，切入隐私模式: ${info.processName} - ${info.windowTitle}`)
  }

  /** 无痕窗口清除回调：退出隐私模式 */
  private onIncognitoCleared(info: WindowInfo): void {
    this.privacyMode = false
    this.emit('incognito-cleared', info)
    this.emit('privacy-mode-exited', info)
    console.warn('[PrivacyGuard] 离开无痕浏览窗口，退出隐私模式')
  }

  /**
   * 首次启动 seed 默认规则到 privacy_rules 表。
   * 若表已有规则则跳过（不覆盖用户自定义规则）。
   */
  seedDefaultRules(): void {
    const existing = PrivacyRuleRepository.getAll()
    if (existing.length > 0) return
    for (const seed of DEFAULT_RULES) {
      PrivacyRuleRepository.insert({
        type: seed.type,
        pattern: seed.pattern,
        matchMode: seed.matchMode,
        enabled: true
      })
    }
    console.log(`[PrivacyGuard] 已 seed ${DEFAULT_RULES.length} 条默认隐私规则`)
  }
}
