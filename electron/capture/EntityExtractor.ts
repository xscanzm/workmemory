/**
 * EntityExtractor：实体提取器
 *
 * 从 Episode 的 OCR 文本（聚合 segmentIds 对应 segments 的 ocr_text）提取实体：
 *  - 人名：中文姓名模式（2-4 字，姓氏常见字 + 名字）+ 英文 Firstname Lastname 模式
 *  - 项目名：任务单号前缀（如 ORD- → 订单）、窗口标题中的"XX项目"、"XX需求"
 *  - 文档：文件名模式（xxx.docx, xxx.pdf, xxx.md, xxx.xlsx）+ 窗口标题中的文档名
 *  - URL：http(s):// 链接
 *
 * 返回 EntityRef[]，去重。与 Episode 关联：更新 Episode.entities 字段。
 */
import type { EntityRef, Episode, WorkSegment } from '@/types'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'

/** 常见中文姓氏（百家姓前 150） */
const COMMON_SURNAMES = new Set([
  '赵', '钱', '孙', '李', '周', '吴', '郑', '王', '冯', '陈',
  '褚', '卫', '蒋', '沈', '韩', '杨', '朱', '秦', '尤', '许',
  '何', '吕', '施', '张', '孔', '曹', '严', '华', '金', '魏',
  '陶', '姜', '戚', '谢', '邹', '喻', '柏', '水', '窦', '章',
  '云', '苏', '潘', '葛', '奚', '范', '彭', '郎', '鲁', '韦',
  '昌', '马', '苗', '凤', '花', '方', '俞', '任', '袁', '柳',
  '酆', '鲍', '史', '唐', '费', '廉', '岑', '薛', '雷', '贺',
  '倪', '汤', '滕', '殷', '罗', '毕', '郝', '邬', '安', '常',
  '乐', '于', '时', '傅', '皮', '卞', '齐', '康', '伍', '余',
  '元', '卜', '顾', '孟', '平', '黄', '和', '穆', '萧', '尹',
  '姚', '邵', '湛', '汪', '祁', '毛', '禹', '狄', '米', '贝',
  '明', '臧', '计', '伏', '成', '戴', '谈', '宋', '茅', '庞',
  '熊', '纪', '舒', '屈', '项', '祝', '董', '梁', '杜', '阮',
  '蓝', '闵', '席', '季', '麻', '强', '贾', '路', '娄', '危',
  '江', '童', '颜', '郭', '梅', '盛', '林', '刁', '钟', '徐'
])

/** 中文姓名中名字部分常见字（用于过滤非姓名的 2-4 字组合） */
const NAME_CHARS = /[\u4e00-\u9fff]/

/** 非姓名的高频双字词（避免误识别） */
const NON_NAME_WORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '这个', '那个', '什么', '怎么',
  '可以', '应该', '需要', '已经', '正在', '如果', '虽然', '但是', '因为',
  '所以', '不过', '然后', '其实', '一般', '通常', '总是', '从不', '偶尔',
  '现在', '今天', '明天', '昨天', '以后', '以前', '目前', '最近', '马上',
  '一下', '一些', '一切', '所有', '其他', '另外', '同时', '同一', '同样',
  '问题', '原因', '结果', '方法', '方式', '方向', '方面', '地方', '时候',
  '感觉', '觉得', '认为', '以为', '知道', '明白', '理解', '发现', '看到',
  '工作', '学习', '生活', '时间', '事情', '东西', '地方', '时候'
])

/** 文件扩展名模式 */
const FILE_EXTENSION_REGEX = /([\u4e00-\u9fff\w.-]+)\.(docx?|pdf|md|xlsx?|pptx?|txt|csv|json|html?|zip|rar|tar|gz)/gi

/** URL 正则 */
const URL_REGEX = /https?:\/\/[^\s<>"'，。、；：！？）】}]+/gi

/** 任务单号前缀 → 项目名映射 */
const TASK_PREFIX_TO_PROJECT: Record<string, string> = {
  ORD: '订单',
  PRD: '需求',
  BUG: '缺陷',
  ISSUE: 'Issue',
  PR: 'PR',
  MR: '合并请求',
  TASK: '任务',
  TODO: '待办',
  JIRA: 'Jira',
  GIT: 'Git',
  API: 'API',
  DOC: '文档',
  SPEC: '规格',
  FEAT: '功能',
  TEST: '测试',
  DEV: '开发',
  OPS: '运维'
}

/** 窗口标题中项目/需求模式 */
const TITLE_PROJECT_REGEX = /([\u4e00-\u9fff\w]{2,10})(项目|需求|功能|模块|系统|平台|工程)/g

/** 英文姓名模式：大写首字母 + 小写名 */
const ENGLISH_NAME_REGEX = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,15})\b/g

/** 任务单号正则 */
const TASK_ID_REGEX = /([A-Z]{2,})-(\d+)/g

/** 强项目关键词（窗口标题中出现时显著提升项目置信度） */
const STRONG_PROJECT_KEYWORDS = /(项目|工程|计划|方案|project)/i

/** 文档编辑器应用名（窗口标题中含此名时提升文档置信度） */
const EDITOR_APP_REGEX = /(Word|Excel|WPS|Notion|Typora|PowerPoint|Pages|Keynote|Numbers|Obsidian)/i

/** 通用单字项目名（避免误识别） */
const GENERIC_PROJECT_WORDS = new Set(['工作', '内容', '事情', '问题', '任务'])

/** 常见顶级域名（用于 URL 置信度计算） */
const COMMON_TLDS = new Set(['com', 'org', 'net', 'cn', 'io', 'dev', 'edu', 'gov', 'info', 'biz'])

/** 中文姓名正则（仅中文） */
const CHINESE_ONLY_REGEX = /^[\u4e00-\u9fff]+$/

/**
 * EntityExtractor：实体提取器。
 */
export class EntityExtractor {
  /**
   * 从 Episode 提取实体。
   * 聚合 segmentIds 对应 segments 的 ocr_text + windowTitle，提取人名/项目名/文档/URL。
   */
  extractFromEpisode(episode: Episode): EntityRef[] {
    const segments = this.getSegmentsForEpisode(episode)
    const aggregatedText = this.aggregateText(segments)
    const windowTitles = segments.map(s => s.windowTitle).join('\n')

    return this.extractFromText(aggregatedText, windowTitles)
  }

  /**
   * 从文本提取实体（OCR 文本 + 窗口标题）。
   * 返回去重后的 EntityRef[]。
   */
  extractFromText(ocrText: string, windowTitles: string): EntityRef[] {
    const entities: EntityRef[] = []
    const seen = new Set<string>()

    const addEntity = (entity: EntityRef): void => {
      const key = `${entity.type}:${entity.name}`
      if (!seen.has(key)) {
        seen.add(key)
        entities.push(entity)
      }
    }

    // 合并文本用于提取
    const fullText = `${ocrText}\n${windowTitles}`

    // 1. 提取人名
    for (const person of this.extractPersons(ocrText)) {
      addEntity(person)
    }

    // 2. 提取项目名
    for (const project of this.extractProjects(fullText, windowTitles)) {
      addEntity(project)
    }

    // 3. 提取文档
    for (const doc of this.extractDocuments(fullText)) {
      addEntity(doc)
    }

    // 4. 提取 URL
    for (const url of this.extractUrls(fullText)) {
      addEntity(url)
    }

    return entities
  }

  /**
   * 提取并保存指定日期所有 Episode 的实体。
   * 更新每个 Episode 的 entities 字段。
   */
  extractAndSaveForDate(date: string): void {
    const episodes = EpisodeRepository.getByDate(date)
    for (const episode of episodes) {
      // 跳过每日总结 Episode
      if (episode.topics.includes('__daily_summary__')) continue
      // 跳过用户编辑过的 Episode（不覆盖用户内容）
      if (episode.userEdited) continue

      const entities = this.extractFromEpisode(episode)
      EpisodeRepository.update(episode.id, { entities })
    }
  }

  // ===================== 内部提取方法 =====================

  /** 获取 Episode 关联的 Segments */
  private getSegmentsForEpisode(episode: Episode): WorkSegment[] {
    const segments: WorkSegment[] = []
    for (const segmentId of episode.segmentIds) {
      const segment = SegmentRepository.getById(segmentId)
      if (segment && !segment.isDeleted) {
        segments.push(segment)
      }
    }
    return segments
  }

  /** 聚合 Segments 的 OCR 文本 */
  private aggregateText(segments: WorkSegment[]): string {
    return segments.map(s => s.ocrText).filter(t => t.length > 0).join('\n')
  }

  /** 提取人名（中文姓名 + 英文姓名） */
  private extractPersons(text: string): EntityRef[] {
    const persons: EntityRef[] = []
    const seen = new Set<string>()

    // 中文姓名提取：2-4 字，首字为常见姓氏
    const chineseNameRegex = /([\u4e00-\u9fff]{2,4})/g
    let match: RegExpExecArray | null
    while ((match = chineseNameRegex.exec(text)) !== null) {
      const name = match[1]
      if (this.isValidChineseName(name)) {
        if (!seen.has(name)) {
          seen.add(name)
          persons.push({ type: 'person', name, confidence: this.computePersonConfidence(name) })
        }
      }
    }

    // 英文姓名提取：Firstname Lastname
    ENGLISH_NAME_REGEX.lastIndex = 0
    while ((match = ENGLISH_NAME_REGEX.exec(text)) !== null) {
      const fullName = `${match[1]} ${match[2]}`
      if (!seen.has(fullName)) {
        seen.add(fullName)
        persons.push({ type: 'person', name: fullName, confidence: this.computeEnglishPersonConfidence(fullName) })
      }
    }

    return persons
  }

  /**
   * 计算中文人名置信度。
   * 基础 0.5；首字常见姓氏 +0.2；长度 2-3 +0.2；长度 >4 -0.3；含非中文 -0.2。
   */
  private computePersonConfidence(name: string): number {
    let confidence = 0.5
    if (COMMON_SURNAMES.has(name[0])) confidence += 0.2
    if (name.length >= 2 && name.length <= 3) confidence += 0.2
    if (name.length > 4) confidence -= 0.3
    if (!CHINESE_ONLY_REGEX.test(name)) confidence -= 0.2
    return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
  }

  /**
   * 计算英文人名置信度。
   * 基础 0.55（已匹配 Firstname Lastname 模式）；首字母大写 +0.15；长度合理 +0.1。
   */
  private computeEnglishPersonConfidence(name: string): number {
    let confidence = 0.55
    const parts = name.split(' ')
    if (parts.length === 2 && parts.every(p => /^[A-Z][a-z]+$/.test(p))) confidence += 0.15
    if (parts.every(p => p.length >= 2 && p.length <= 15)) confidence += 0.1
    return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
  }

  /** 验证是否为有效中文姓名 */
  private isValidChineseName(name: string): boolean {
    // 长度 2-4
    if (name.length < 2 || name.length > 4) return false
    // 首字必须是常见姓氏
    if (!COMMON_SURNAMES.has(name[0])) return false
    // 所有字符必须是中文
    if (!NAME_CHARS.test(name)) return false
    for (const ch of name) {
      if (!NAME_CHARS.test(ch)) return false
    }
    // 排除高频非姓名词
    if (NON_NAME_WORDS.has(name)) return false
    // 排除纯姓氏（单字）
    if (name.length === 1) return false
    return true
  }

  /** 提取项目名（任务单号前缀 + 窗口标题中的项目/需求名） */
  private extractProjects(text: string, windowTitles: string): EntityRef[] {
    const projects: EntityRef[] = []
    const seen = new Set<string>()

    // 从任务单号前缀提取项目名（匹配 ORD-123 等模式，非窗口标题来源）
    TASK_ID_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TASK_ID_REGEX.exec(text)) !== null) {
      const prefix = match[1]
      const projectName = TASK_PREFIX_TO_PROJECT[prefix]
      if (projectName && !seen.has(projectName)) {
        seen.add(projectName)
        projects.push({
          type: 'project',
          name: projectName,
          value: `${prefix}-${match[2]}`,
          confidence: this.computeProjectConfidence(projectName, false, true)
        })
      }
    }

    // 从窗口标题提取项目/需求名（含 项目/工程/计划/方案 等强关键词，匹配 XX项目 模式）
    TITLE_PROJECT_REGEX.lastIndex = 0
    while ((match = TITLE_PROJECT_REGEX.exec(windowTitles)) !== null) {
      const projectName = match[1] + match[2]
      if (!seen.has(projectName) && projectName.length >= 3) {
        seen.add(projectName)
        projects.push({
          type: 'project',
          name: projectName,
          confidence: this.computeProjectConfidence(projectName, true, true)
        })
      }
    }

    return projects
  }

  /**
   * 计算项目名置信度。
   * 基础 0.4；来自窗口标题且含强项目关键词 +0.3；匹配 XX项目/Project XXX 模式 +0.2；过于通用 -0.2。
   */
  private computeProjectConfidence(name: string, fromWindowTitle: boolean, matchesPattern: boolean): number {
    let confidence = 0.4
    if (fromWindowTitle && STRONG_PROJECT_KEYWORDS.test(name)) confidence += 0.3
    if (matchesPattern) confidence += 0.2
    if (GENERIC_PROJECT_WORDS.has(name) || name.length <= 1) confidence -= 0.2
    return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
  }

  /** 提取文档（文件名） */
  private extractDocuments(text: string): EntityRef[] {
    const documents: EntityRef[] = []
    const seen = new Set<string>()
    const hasEditorContext = EDITOR_APP_REGEX.test(text)

    FILE_EXTENSION_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = FILE_EXTENSION_REGEX.exec(text)) !== null) {
      const fileName = match[0]
      if (!seen.has(fileName)) {
        seen.add(fileName)
        documents.push({
          type: 'document',
          name: fileName,
          confidence: this.computeDocumentConfidence(fileName, hasEditorContext)
        })
      }
    }

    return documents
  }

  /**
   * 计算文档置信度。
   * 基础 0.6；含明确文件扩展名 +0.2；窗口标题含编辑器应用名 +0.1；无扩展名且无编辑器上下文 -0.3。
   */
  private computeDocumentConfidence(fileName: string, hasEditorContext: boolean): number {
    let confidence = 0.6
    const hasExtension = /\.(docx?|pdf|md|xlsx?|pptx?|txt|csv|json|html?|zip|rar|tar|gz)$/i.test(fileName)
    if (hasExtension) confidence += 0.2
    if (hasEditorContext) confidence += 0.1
    if (!hasExtension && !hasEditorContext) confidence -= 0.3
    return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
  }

  /** 提取 URL */
  private extractUrls(text: string): EntityRef[] {
    const urls: EntityRef[] = []
    const seen = new Set<string>()

    URL_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = URL_REGEX.exec(text)) !== null) {
      const url = match[0]
      if (!seen.has(url)) {
        seen.add(url)
        urls.push({
          type: 'url',
          name: url,
          value: url,
          confidence: this.computeUrlConfidence(url)
        })
      }
    }

    return urls
  }

  /**
   * 计算 URL 置信度。
   * 基础 0.7；以 http(s):// 开头 +0.2；含合法 TLD +0.1；形似文件路径 -0.3。
   */
  private computeUrlConfidence(url: string): number {
    let confidence = 0.7
    if (/^https?:\/\//i.test(url)) confidence += 0.2
    const hostMatch = url.match(/^https?:\/\/([^/?#]+)/i)
    if (hostMatch) {
      const host = hostMatch[1]
      const tld = host.split('.').pop()?.toLowerCase() ?? ''
      if (COMMON_TLDS.has(tld)) confidence += 0.1
    }
    if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/')) confidence -= 0.3
    return Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))
  }
}
