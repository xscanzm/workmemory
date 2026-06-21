/**
 * SettingsStore：应用设置持久化
 * 使用 userData/settings.json 文件存储，合并默认设置。
 * 开机自启通过 electron app.setLoginItemSettings 实现。
 *
 * API Key 加密存储（Task A2）：
 *  - API Key 通过 Electron safeStorage.encryptString 加密后以 base64 blob 存为 apiKeyEncrypted
 *  - settings.json 永不出现明文 apiKey
 *  - get() 返回的 AppSettings 含 apiKeyMasked（如 sk-****xxxx）供 UI 显示，不含明文也不含加密 blob
 *  - getApiKey() 运行时解密返回明文 key 供 AI 模块调用
 *  - safeStorage 在 Linux 沙箱可能不可用（isEncryptionAvailable() 返回 false），
 *    此时降级为机器级 XOR + base64（仅环境降级；Windows 上 safeStorage 在 app ready 后始终可用，
 *    生产环境使用真实 DPAPI 加密）。
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings, MascotStyle, OcrModel } from '@/types'

/**
 * 持久化到 settings.json 的内部结构。
 * 与 AppSettings 的区别：用 apiKeyEncrypted（base64 加密 blob）替代 apiKeyMasked（派生字段，不落盘）。
 */
interface PersistedSettings {
  autoStart: boolean
  screenshotRetentionDays: number
  ocrModel: OcrModel
  /** safeStorage 加密后的 base64 blob，空字符串表示未配置 */
  apiKeyEncrypted: string
  apiBaseUrl: string
  modelName: string
  mascotStyle: MascotStyle
  saveScreenshots: boolean
  /**
   * 是否允许活跃窗口截图失败后整屏降级。默认 true，保证屏幕识别开箱可用。
   * 关闭后 CaptureDecision 会在窗口截图失败时跳过，不调用 captureScreen。
   */
  allowFullScreenshotFallback: boolean
  aiAutoDistillEnabled: boolean
  aiAutoDistillFirstConsentAt: string
  aiDistillSchedule: 'hourly'
  aiDistillLastRunAt: string
  aiDistillSendScreenshots: boolean
}

/** 默认持久化设置 */
const defaultPersistedSettings: PersistedSettings = {
  autoStart: false,
  screenshotRetentionDays: 0,
  ocrModel: 'tiny',
  apiKeyEncrypted: '',
  apiBaseUrl: 'https://api.openai.com/v1',
  modelName: 'gpt-4o-mini',
  mascotStyle: 'note',
  saveScreenshots: false,
  allowFullScreenshotFallback: true,
  aiAutoDistillEnabled: false,
  aiAutoDistillFirstConsentAt: '',
  aiDistillSchedule: 'hourly',
  aiDistillLastRunAt: '',
  aiDistillSendScreenshots: false
}

let settingsCache: PersistedSettings | null = null

function getSettingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

// ===================== API Key 加密 / 解密 =====================

/**
 * 机器级 XOR 降级密钥（仅 Linux 沙箱 safeStorage 不可用时使用）。
 * 结合 hostname + 用户名，保证不同机器/用户间密文不可直接复用。
 * 注意：这是环境降级方案，不是安全加密；Windows 生产环境使用 safeStorage（DPAPI）。
 */
function getXorFallbackKey(): string {
  let username = 'unknown'
  try {
    username = os.userInfo().username
  } catch {
    username = 'unknown'
  }
  return `WorkMemory::${os.hostname()}::${username}`
}

/** XOR 加密，返回 Buffer */
function xorCipher(input: Buffer, key: string): Buffer {
  const keyBuf = Buffer.from(key, 'utf-8')
  const result = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i++) {
    result[i] = input[i] ^ keyBuf[i % keyBuf.length]
  }
  return result
}

/**
 * 加密 API Key 为 base64 字符串。
 * 优先使用 Electron safeStorage（Windows DPAPI / macOS Keychain / Linux libsecret）；
 * 当 safeStorage 不可用（Linux 沙箱无 secret service）时降级为机器级 XOR + base64。
 */
function encryptApiKey(plainKey: string): string {
  if (!plainKey) return ''
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(plainKey)
    return encrypted.toString('base64')
  }
  // 环境降级：Linux 沙箱无 safeStorage，使用机器级 XOR + base64。
  // Windows 上 safeStorage.isEncryptionAvailable() 在 app ready 后始终为 true，不会走到这里。
  const xorBuf = xorCipher(Buffer.from(plainKey, 'utf-8'), getXorFallbackKey())
  return `xor:${xorBuf.toString('base64')}`
}

/**
 * 解密 API Key base64 字符串为明文。
 * 解密失败（如换机器导致 DPAPI 密钥不匹配）返回空字符串，不抛异常。
 */
function decryptApiKey(encryptedBlob: string): string {
  if (!encryptedBlob) return ''
  try {
    if (encryptedBlob.startsWith('xor:')) {
      // 降级密文
      const payload = encryptedBlob.slice(4)
      const buf = Buffer.from(payload, 'base64')
      return xorCipher(buf, getXorFallbackKey()).toString('utf-8')
    }
    if (safeStorage.isEncryptionAvailable()) {
      const buf = Buffer.from(encryptedBlob, 'base64')
      return safeStorage.decryptString(buf)
    }
    // safeStorage 不可用且非降级密文：无法解密
    return ''
  } catch {
    // 解密失败（换机器、密钥变更等），返回空字符串，UI 显示"未配置"
    return ''
  }
}

/**
 * 将明文 API Key 转为掩码（如 sk-****xxxx），供 UI 显示。
 * 永不暴露完整 key。
 */
function maskApiKey(plainKey: string): string {
  if (!plainKey) return ''
  // 太短的 key 无法安全掩码，统一显示 ****
  if (plainKey.length <= 7) return '****'
  const prefix = plainKey.slice(0, 3)
  const suffix = plainKey.slice(-4)
  return `${prefix}****${suffix}`
}

// ===================== 磁盘读写 =====================

/**
 * 读取磁盘上的 settings.json，合并默认设置。
 * 兼容旧版明文 apiKey 字段：若存在则迁移为 apiKeyEncrypted 并删除明文。
 */
function readSettings(): PersistedSettings {
  const filePath = getSettingsFilePath()
  try {
    if (!fs.existsSync(filePath)) {
      return { ...defaultPersistedSettings }
    }
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const result: PersistedSettings = {
      ...defaultPersistedSettings,
      ...(parsed as Partial<PersistedSettings>)
    }

    // 兼容旧版明文 apiKey：迁移为加密 blob 后清除明文
    const legacyApiKey = parsed['apiKey']
    if (typeof legacyApiKey === 'string' && legacyApiKey.length > 0 && !result.apiKeyEncrypted) {
      result.apiKeyEncrypted = encryptApiKey(legacyApiKey)
    }

    return result
  } catch {
    return { ...defaultPersistedSettings }
  }
}

/** 将设置写入磁盘（不含 apiKeyMasked 派生字段，不含明文 apiKey） */
function writeSettings(settings: PersistedSettings): void {
  const filePath = getSettingsFilePath()
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8')
  } catch (e) {
    console.warn('[SettingsStore] 写入设置失败:', e)
  }
}

/** 同步开机自启状态到系统 */
function syncAutoStart(autoStart: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: autoStart,
      args: ['--hidden']
    })
  } catch (e) {
    console.warn('[SettingsStore] 设置开机自启失败:', e)
  }
}

/**
 * 将持久化设置转为 UI 可见的 AppSettings。
 * apiKeyEncrypted 被解密后转为 apiKeyMasked，永不暴露明文或加密 blob。
 */
function toAppSettings(persisted: PersistedSettings): AppSettings {
  const plainKey = decryptApiKey(persisted.apiKeyEncrypted)
  return {
    autoStart: persisted.autoStart,
    screenshotRetentionDays: persisted.screenshotRetentionDays,
    ocrModel: persisted.ocrModel,
    apiKeyMasked: maskApiKey(plainKey),
    apiBaseUrl: persisted.apiBaseUrl,
    modelName: persisted.modelName,
    mascotStyle: persisted.mascotStyle,
    saveScreenshots: persisted.saveScreenshots,
    allowFullScreenshotFallback: persisted.allowFullScreenshotFallback,
    aiAutoDistillEnabled: persisted.aiAutoDistillEnabled,
    aiAutoDistillFirstConsentAt: persisted.aiAutoDistillFirstConsentAt,
    aiDistillSchedule: persisted.aiDistillSchedule,
    aiDistillLastRunAt: persisted.aiDistillLastRunAt,
    aiDistillSendScreenshots: persisted.aiDistillSendScreenshots
  }
}

export const SettingsStore = {
  /** 获取完整设置（带缓存），返回 UI 可见的 AppSettings（含 apiKeyMasked，不含明文） */
  get(): AppSettings {
    if (!settingsCache) {
      settingsCache = readSettings()
    }
    return toAppSettings(settingsCache)
  },

  /**
   * 更新设置（合并 patch），写入磁盘并立即生效。
   * apiKeyMasked 是派生字段，传入会被忽略；API Key 请使用 setApiKey/clearApiKey。
   * @returns 更新后的完整设置（UI 可见）
   */
  set(patch: Partial<AppSettings>): AppSettings {
    const current = settingsCache ?? readSettings()
    // apiKeyMasked 是派生字段，不接受外部写入
    const { apiKeyMasked: _ignored, ...writablePatch } = patch
    void _ignored
    const next: PersistedSettings = { ...current, ...writablePatch }
    settingsCache = next
    writeSettings(next)

    // 立即生效：开机自启
    if (patch.autoStart !== undefined && patch.autoStart !== current.autoStart) {
      syncAutoStart(patch.autoStart)
    }

    return toAppSettings(next)
  },

  /** 重置为默认设置（同时清除 API Key） */
  reset(): AppSettings {
    settingsCache = { ...defaultPersistedSettings }
    writeSettings(settingsCache)
    syncAutoStart(false)
    return toAppSettings(settingsCache)
  },

  /**
   * 运行时解密返回明文 API Key，供 AI 模块调用。
   * 解密失败（换机器、密钥变更等）返回空字符串。
   */
  getApiKey(): string {
    if (!settingsCache) {
      settingsCache = readSettings()
    }
    return decryptApiKey(settingsCache.apiKeyEncrypted)
  },

  /** 加密并保存 API Key */
  setApiKey(key: string): void {
    const current = settingsCache ?? readSettings()
    const next: PersistedSettings = {
      ...current,
      apiKeyEncrypted: encryptApiKey(key)
    }
    settingsCache = next
    writeSettings(next)
  },

  /** 清空 API Key（删除 apiKeyEncrypted） */
  clearApiKey(): void {
    const current = settingsCache ?? readSettings()
    const next: PersistedSettings = { ...current, apiKeyEncrypted: '' }
    settingsCache = next
    writeSettings(next)
  },

  /** 仅获取 Mascot 样式 */
  getMascotStyle(): MascotStyle {
    if (!settingsCache) {
      settingsCache = readSettings()
    }
    return settingsCache.mascotStyle
  },

  /** 仅设置 Mascot 样式 */
  setMascotStyle(style: MascotStyle): void {
    this.set({ mascotStyle: style })
  },

  /** 仅获取 OCR 模型 */
  getOcrModel(): OcrModel {
    if (!settingsCache) {
      settingsCache = readSettings()
    }
    return settingsCache.ocrModel
  }
}
