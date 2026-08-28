export interface LocalAttachmentProjection {
  index: number
  name: string
  mimeType: string
  byteSize: number
}

const CONVERSION_REQUEST = /(?:转换|转成|转为|导出为|另存为|万象转换|\bconvert\b|\btranscode\b|\bexport\s+(?:as|to)\b|\bsave\s+as\b)/iu
const NEGATED_CONVERSION_REQUEST = /(?:不要|无需|不必|别|禁止|请勿)\s*(?:把|将)?\s*(?:这|这个|该|当前)?\s*(?:附件|文件)?\s*(?:转换|转成|转为|导出为|另存为)|\b(?:do\s+not|don't|never)\s+(?:convert|transcode|export)\b/iu
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export function sanitizeDisplayName(value: string, index = 0): string {
  const fallback = `附件-${index + 1}`
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || /^(?:data:|https?:\/\/|file:)/iu.test(trimmed)) return fallback
  const segments = trimmed.split(/[\\/\p{Cc}\p{Zl}\p{Zp}]+/gu)
    .map((segment) => segment.trim())
    .filter(Boolean)
  let name = segments.at(-1) ?? ''
  name = name
    .replace(/[<>:"|?*]/gu, '')
    .replace(/[.\s]+$/gu, '')
    .trim()
    .slice(0, 255)
  if (!name || name === '.' || name === '..' || WINDOWS_RESERVED_NAME.test(name)) return fallback
  return name
}

export function hasLocalConversionIntent(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): boolean {
  if (attachments.length === 0 || !text.trim() || NEGATED_CONVERSION_REQUEST.test(text)) return false
  return CONVERSION_REQUEST.test(text)
}

export function projectLocalConversionPrompt(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): string {
  const lines = attachments.map((item) => (
    `[附件 ${item.index}: ${sanitizeDisplayName(item.name, item.index)}, ${item.mimeType}, ${item.byteSize} bytes]`
  ))
  return [text, ...lines].filter(Boolean).join('\n')
}
