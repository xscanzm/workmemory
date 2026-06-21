/**
 * 工作类型分类工具
 * 根据 app_name / process_name 将工作片段分类为沟通/文档/开发/杂务。
 */

export type WorkType = 'communication' | 'document' | 'development' | 'misc'

/** 沟通类应用关键词 */
const COMMUNICATION_APPS: string[] = [
  '微信', 'wechat', '钉钉', 'dingtalk', '飞书', 'feishu', 'lark',
  'slack', 'teams', 'qq', 'telegram', '企业微信', 'wecom',
  'skype', 'discord', 'whatsapp', 'imessage'
]

/** 文档类应用关键词 */
const DOCUMENT_APPS: string[] = [
  'word', 'wps', 'notion', 'obsidian', 'typora', 'markdown',
  'excel', 'powerpoint', 'ppt', 'onenote', '印象笔记', 'evernote',
  'pages', 'numbers', 'keynote', 'google docs', 'google sheets',
  '语雀', 'yuque', '石墨', 'shimo', '腾讯文档'
]

/** 开发类应用关键词 */
const DEVELOPMENT_APPS: string[] = [
  'vscode', 'visual studio code', 'idea', 'intellij', 'webstorm',
  'pycharm', 'goland', 'clion', 'phpstorm', 'rubymine', 'rider',
  'terminal', 'cmd', 'powershell', 'pwsh', 'git', 'xcode',
  'sublime', 'vim', 'neovim', 'emacs', 'eclipse', 'netbeans',
  'docker', 'postman', 'insomnia', 'datagrip', 'navicat',
  'dbeaver', 'redis', 'visual studio', 'devenv'
]

function normalize(s: string): string {
  return s.toLowerCase().trim()
}

/** 根据 app_name 和 process_name 分类工作类型 */
export function classifyWorkType(appName: string, processName: string): WorkType {
  const app = normalize(appName)
  const proc = normalize(processName)
  const combined = `${app} ${proc}`

  for (const keyword of COMMUNICATION_APPS) {
    if (combined.includes(keyword)) return 'communication'
  }
  for (const keyword of DOCUMENT_APPS) {
    if (combined.includes(keyword)) return 'document'
  }
  for (const keyword of DEVELOPMENT_APPS) {
    if (combined.includes(keyword)) return 'development'
  }
  return 'misc'
}

/** 获取工作类型中文标签 */
export function getWorkTypeLabel(type: WorkType): string {
  switch (type) {
    case 'communication':
      return '沟通'
    case 'document':
      return '文档'
    case 'development':
      return '开发'
    case 'misc':
      return '杂务'
  }
}

/** 获取工作类型颜色 */
export function getWorkTypeColor(type: WorkType): string {
  switch (type) {
    case 'communication':
      return '#2b7fff'
    case 'document':
      return '#22b56a'
    case 'development':
      return '#8b5cf6'
    case 'misc':
      return '#8a98aa'
  }
}
