/**
 * 日期时间工具函数
 * 供 Today / Calendar / Search / Insights 页面共享。
 */

/** 获取今日日期字符串 YYYY-MM-DD */
export function getTodayDate(): string {
  return formatDate(new Date())
}

/** 格式化 Date 为 YYYY-MM-DD */
export function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 解析 YYYY-MM-DD 为 Date（本地时区） */
export function parseDate(dateStr: string): Date {
  const parts = dateStr.split('-').map(Number)
  if (parts.length === 3) {
    return new Date(parts[0], parts[1] - 1, parts[2])
  }
  return new Date()
}

/** 将 HH:MM:SS 或 HH:MM 时间字符串转为秒数 */
export function timeToSeconds(timeStr: string): number {
  if (!timeStr) return 0
  const parts = timeStr.split(':')
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)
  }
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60
  }
  const n = parseInt(timeStr, 10)
  return isNaN(n) ? 0 : n
}

/** 格式化秒数为 "Xh Ym" / "Ym" / "Xs" */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

/** 格式化时间范围 "HH:MM - HH:MM" */
export function formatTimeRange(start: string, end: string): string {
  const fmt = (t: string): string => {
    const parts = t.split(':')
    if (parts.length >= 2) return `${parts[0]}:${parts[1]}`
    return t
  }
  return `${fmt(start)} - ${fmt(end)}`
}

/**
 * 获取月份网格（6 周 42 天），从周日开始。
 * 包含上月末尾和下月开头的填充天。
 */
export function getMonthGrid(year: number, month: number): Date[] {
  const firstDay = new Date(year, month, 1)
  const startDayOfWeek = firstDay.getDay()
  const gridStart = new Date(year, month, 1 - startDayOfWeek)
  const days: Date[] = []
  for (let i = 0; i < 42; i++) {
    days.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i))
  }
  return days
}

/** 获取指定日期所在周的 7 天（从周日开始） */
export function getWeekDates(date: Date): Date[] {
  const dayOfWeek = date.getDay()
  const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - dayOfWeek)
  const days: Date[] = []
  for (let i = 0; i < 7; i++) {
    days.push(new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i))
  }
  return days
}

/** 添加天数，返回新 Date */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** 判断两个 Date 是否同一天 */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 获取星期几中文名 */
export function getDayOfWeekName(date: Date): string {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[date.getDay()]
}

/** 计算 Episode 时长（秒） */
export function getEpisodeDuration(startTime: string, endTime: string): number {
  const start = timeToSeconds(startTime)
  const end = timeToSeconds(endTime)
  return Math.max(0, end - start)
}

/** 获取最近 N 天的日期字符串数组（含今天，按时间正序） */
export function getRecentDates(days: number): string[] {
  const today = new Date()
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    dates.push(formatDate(addDays(today, -i)))
  }
  return dates
}

/** 获取本周一到周日的日期数组 */
export function getThisWeekDates(): string[] {
  const today = new Date()
  const dayOfWeek = today.getDay()
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = addDays(today, mondayOffset)
  const dates: string[] = []
  for (let i = 0; i < 7; i++) {
    dates.push(formatDate(addDays(monday, i)))
  }
  return dates
}

/** 获取本月所有日期字符串 */
export function getThisMonthDates(): string[] {
  const today = new Date()
  const year = today.getFullYear()
  const month = today.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const dates: string[] = []
  for (let i = 1; i <= daysInMonth; i++) {
    dates.push(formatDate(new Date(year, month, i)))
  }
  return dates
}

/** 获取指定年月所有日期字符串 */
export function getMonthDates(year: number, month: number): string[] {
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const dates: string[] = []
  for (let i = 1; i <= daysInMonth; i++) {
    dates.push(formatDate(new Date(year, month, i)))
  }
  return dates
}
