export interface LocalAttachmentProjection {
  index: number
  name: string
  mimeType: string
  byteSize: number
}

const CONVERSION_REQUEST = /(?:转换|转成|转为|导出为|另存为|万象转换|\bconvert\b|\btranscode\b|\bexport\s+(?:as|to)\b|\bsave\s+as\b)/giu
const NEGATED_CONVERSION_PREFIX = /(?:(?:不要|无需|不必|别|禁止|请勿)\s*(?:把|将)?\s*(?:这|这个|该|当前)?\s*(?:附件|文件)?|\b(?:do\s+not|don't|never))\s*$/iu
const RESERVED_SUMMARY_LABEL = /(?:附\s*件|目\s*标\s*格\s*式)/iu
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export function sanitizeDisplayName(value: string, index = 0): string {
  const fallback = `文件-${index + 1}`
  const trimmed = typeof value === 'string' ? value.trim() : ''
  const normalized = trimmed.normalize('NFKC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, '/')
    .replace(/[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, '')
  if (!normalized || /^(?:data:|https?:\/\/|file:)/iu.test(normalized)) return fallback
  const segments = normalized.split(/[\\/]+/gu)
    .map((segment) => segment.trim())
    .filter(Boolean)
  let name = segments.at(-1) ?? ''
  if (RESERVED_SUMMARY_LABEL.test(name)) return fallback
  name = [...name]
    .map((character) => /[\p{L}\p{M}\p{N} ._()-]/u.test(character) ? character : '-')
    .join('')
    .replace(/\s+/gu, ' ')
    .replace(/[.\s]+$/gu, '')
    .trim()
  name = [...name].slice(0, 255).join('')
  if (!name || name === '.' || name === '..' || WINDOWS_RESERVED_NAME.test(name)) return fallback
  return name
}

export function hasLocalConversionIntent(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): boolean {
  if (attachments.length === 0 || !text.trim()) return false
  return [...text.matchAll(CONVERSION_REQUEST)].some((match) => {
    const prefix = text.slice(0, match.index)
    const clausePrefix = prefix.split(/[，,；;。.!！？?\n]/u).at(-1) ?? ''
    return !NEGATED_CONVERSION_PREFIX.test(clausePrefix)
  })
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
