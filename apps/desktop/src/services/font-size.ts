import type { AppFontSize } from '@autoforge/shared'

export const defaultAppFontSize: AppFontSize = 'normal'

export const appFontSizeOptions: ReadonlyArray<{
  value: AppFontSize
  label: string
}> = [
  { value: 'extra-small', label: '超小' },
  { value: 'small', label: '小' },
  { value: 'normal', label: '正常' },
  { value: 'large', label: '大' },
  { value: 'extra-large', label: '超大' },
]

export function isAppFontSize(value: unknown): value is AppFontSize {
  return appFontSizeOptions.some((option) => option.value === value)
}

export function applyAppFontSize(value: AppFontSize | undefined): void {
  document.documentElement.dataset.fontSize = value ?? defaultAppFontSize
  window.dispatchEvent(new Event('autoforge:font-size-change'))
}

export function currentAppFontScale(): number {
  const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(rootFontSize) ? rootFontSize / 16 : 1
}
