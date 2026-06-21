/**
 * SensitiveMasker：敏感信息脱敏器（纯函数）
 *
 * 对文本中的手机号 / 邮箱 / 身份证号 / 银行卡号自动掩码，避免明文上传到 AI。
 * 用于 ReportGenerator 构建 AI 输入前对 OCR 摘要文本脱敏，以及前端确认面板显示脱敏统计。
 *
 * 掩码规则：
 *  - 手机号（11 位，1[3-9] 开头）：13812345678 → 138****5678
 *  - 邮箱：user@example.com → u***@example.com
 *  - 身份证号（18 位，末位可为 X/x）：110101199001011234 → 110101********1234
 *  - 银行卡号（16-19 位连续数字）：6222020200011111 → 6222****1111
 *
 * 匹配顺序：邮箱 > 身份证 > 手机号 > 银行卡（避免 18 位身份证被银行卡规则误匹配）。
 * 使用负向断言 (?<!\d) / (?!\d) 避免匹配更长数字串的子串。
 */

/** 脱敏结果 */
export interface MaskResult {
  /** 脱敏后的文本 */
  text: string
  /** 被脱敏的敏感项数量 */
  maskedCount: number
}

/** 单条脱敏规则 */
interface MaskRule {
  /** 匹配正则（全局） */
  regex: RegExp
  /** 掩码函数：返回掩码后的字符串 */
  mask: (match: string) => string
}

/**
 * 脱敏规则集合（顺序敏感：先匹配更具体的模式）。
 * 身份证（18 位）在银行卡（16-19 位）之前，避免身份证被银行卡规则吞掉。
 */
const MASK_RULES: MaskRule[] = [
  // 邮箱：user.name+tag@example.com → u***@example.com
  {
    regex: /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/g,
    mask: (m) => {
      const atIdx = m.indexOf('@')
      if (atIdx <= 0) return m
      const local = m.slice(0, atIdx)
      const domain = m.slice(atIdx)
      const maskedLocal = local.length <= 1 ? '*' : local[0] + '***'
      return maskedLocal + domain
    }
  },
  // 身份证号：18 位，末位可为 X/x。110101199001011234 → 110101********1234
  {
    regex: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    mask: (m) => m.slice(0, 6) + '********' + m.slice(-4)
  },
  // 手机号：1[3-9] 开头共 11 位。13812345678 → 138****5678
  {
    regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    mask: (m) => m.slice(0, 3) + '****' + m.slice(-4)
  },
  // 银行卡号：16-19 位连续数字。6222020200011111 → 6222****1111
  {
    regex: /(?<!\d)\d{16,19}(?!\d)/g,
    mask: (m) => m.slice(0, 4) + '****' + m.slice(-4)
  }
]

/**
 * 对文本进行敏感信息脱敏。
 * 依次应用邮箱 / 身份证 / 手机号 / 银行卡掩码规则，累计脱敏次数。
 *
 * @param text 原始文本
 * @returns 脱敏结果（含掩码后文本与脱敏次数）
 */
export function maskSensitive(text: string): MaskResult {
  if (!text || text.length === 0) return { text: '', maskedCount: 0 }
  let result = text
  let maskedCount = 0
  for (const rule of MASK_RULES) {
    // 重置 lastIndex（全局正则在多次调用间需重置）
    rule.regex.lastIndex = 0
    result = result.replace(rule.regex, (match) => {
      maskedCount += 1
      return rule.mask(match)
    })
  }
  return { text: result, maskedCount }
}
