/**
 * WorkMemory 亮色主题色板 (calm light theme)
 * 蓝/青色调点缀，专业沉稳。与 src/index.css :root 中的 --wm-color-* 变量保持同步。
 */

export const lightTheme = {
  name: 'calm-light',
  colors: {
    background: '#f5f7fa',
    surface: '#ffffff',
    surfaceAlt: '#eef2f7',
    sidebar: 'rgba(238, 242, 247, 0.72)',
    textPrimary: '#1a2332',
    textSecondary: '#5a6a7e',
    textMuted: '#8a98aa',
    accent: '#2b7fff',
    accentHover: '#1a6fef',
    accentSoft: 'rgba(43, 127, 255, 0.1)',
    cyan: '#22c5d8',
    cyanSoft: 'rgba(34, 197, 216, 0.12)',
    border: '#e1e7ef',
    borderStrong: '#cdd6e2',
    success: '#22b56a',
    warning: '#f5a623',
    danger: '#e5484d',
    privacy: '#8b5cf6',
    shadow: 'rgba(0, 0, 0, 0.1)'
  }
} as const

export type LightTheme = typeof lightTheme
export type ThemeColor = keyof typeof lightTheme.colors

/** 8 大导航项的强调色（用于 IconSidebar 激活态点缀） */
export const navAccentColors: Record<string, string> = {
  today: lightTheme.colors.accent,
  calendar: lightTheme.colors.cyan,
  search: '#7c5cff',
  insights: '#f5a623',
  wiki: '#22b56a',
  graph: '#e5484d',
  reports: '#2b7fff',
  settings: '#5a6a7e'
}
