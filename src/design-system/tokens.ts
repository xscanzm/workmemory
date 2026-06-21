/**
 * WorkMemory 设计系统 Token
 * 间距 / 圆角 / 阴影 / 层级
 * TypeScript 常量 + CSS 变量双重导出：JS 直接引用常量，CSS 引用 --wm-* 变量。
 * 两者保持同步（CSS 变量定义于 src/index.css :root）。
 */

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const

export type SpacingKey = keyof typeof spacing
export type SpacingValue = (typeof spacing)[SpacingKey]

export const radius = {
  card: 8,
  button: 6,
  pill: 999,
  none: 0
} as const

export type RadiusKey = keyof typeof radius
export type RadiusValue = (typeof radius)[RadiusKey]

export const shadow = {
  card: '0px 4px 16px rgba(0, 0, 0, 0.1)',
  window: '0px 8px 32px rgba(0, 0, 0, 0.16)',
  none: 'none'
} as const

export type ShadowKey = keyof typeof shadow
export type ShadowValue = (typeof shadow)[ShadowKey]

export const zIndex = {
  base: 0,
  sidebar: 10,
  titlebar: 100,
  modal: 1000,
  mascot: 2000
} as const

export type ZIndexKey = keyof typeof zIndex

/** CSS 变量名映射，便于在 JS 中通过 var() 引用 */
export const cssVar = {
  spacingXs: 'var(--wm-spacing-xs)',
  spacingSm: 'var(--wm-spacing-sm)',
  spacingMd: 'var(--wm-spacing-md)',
  spacingLg: 'var(--wm-spacing-lg)',
  spacingXl: 'var(--wm-spacing-xl)',
  spacingXxl: 'var(--wm-spacing-xxl)',
  radiusCard: 'var(--wm-radius-card)',
  radiusButton: 'var(--wm-radius-button)',
  radiusPill: 'var(--wm-radius-pill)',
  shadowCard: 'var(--wm-shadow-card)',
  shadowWindow: 'var(--wm-shadow-window)'
} as const

/** 完整的 CSS 变量声明块（与 src/index.css :root 保持一致，可用于动态注入场景） */
export const cssVariablesBlock = `:root {
  --wm-spacing-xs: ${spacing.xs}px;
  --wm-spacing-sm: ${spacing.sm}px;
  --wm-spacing-md: ${spacing.md}px;
  --wm-spacing-lg: ${spacing.lg}px;
  --wm-spacing-xl: ${spacing.xl}px;
  --wm-spacing-xxl: ${spacing.xxl}px;
  --wm-radius-card: ${radius.card}px;
  --wm-radius-button: ${radius.button}px;
  --wm-radius-card-shadow: ${shadow.card};
}`
