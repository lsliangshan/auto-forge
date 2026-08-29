import { CONVERSION_TARGET_FORMATS } from '@autoforge/shared'

export interface LocalAttachmentProjection {
  index: number
  name: string
  mimeType: string
  byteSize: number
}

const CONVERSION_TARGET_PATTERN = `(?:${CONVERSION_TARGET_FORMATS.join('|')})`
const CONVERSION_REQUEST = /(?:转换|转成|转为|导出为|另存为|万象转换|\bconvert\b|\btranscode\b|\bexport\s+(?:as|to)\b|\bsave\s+as\b)/iu
const CHINESE_TARGETED_CONVERSION_CLAUSE = `(?:做成|制作成|输出(?:成|为)|(?:保存|存)[^，,；;。.!！？?]{0,24}?(?:成|为))\\s*${CONVERSION_TARGET_PATTERN}(?=$|[^\\p{L}\\p{N}])`
const ENGLISH_ATTACHMENT_NOUN = `(?:(?:this|the|that|current|my|your|an?)\\s+)?(?:image|photo|picture|attachment|file|document|video|audio)`
const ENGLISH_TARGETED_CONVERSION_CLAUSE = `(?:make\\s+${ENGLISH_ATTACHMENT_NOUN}\\s+(?:(?:into|as)\\s+|an?\\s+)?${CONVERSION_TARGET_PATTERN}|(?:save|export)\\s+${ENGLISH_ATTACHMENT_NOUN}\\s+(?:as|to)\\s+${CONVERSION_TARGET_PATTERN}|(?:turn|change)\\s+${ENGLISH_ATTACHMENT_NOUN}\\s+(?:into|to)\\s+${CONVERSION_TARGET_PATTERN})(?=$|[^\\p{L}\\p{N}])`
const TARGETED_CONVERSION_REQUEST = new RegExp(
  `(?:${CHINESE_TARGETED_CONVERSION_CLAUSE}|\\b${ENGLISH_TARGETED_CONVERSION_CLAUSE})`,
  'iu',
)
const FULLY_NEGATED_CONVERSION_REQUESTS = [
  /^(?:请\s*)?(?:不要|无需|不必|别|禁止|请勿)\s*(?:把|将)?\s*(?:(?:这|这个|该|当前)\s*)?(?:附件|文件)?\s*(?:转换|转成|转为|导出为|另存为|万象转换)(?:\s*(?:(?:这|这个|该|当前)\s*)?(?:附件|文件))?(?:\s*(?:成|为|到)?\s*[\p{L}\p{N}._-]+)?\s*[。.!！]?$/iu,
  /^(?:please\s+)?(?:do\s+not|don't|never)\s+(?:(?:convert|transcode)(?:\s+(?:this|the|current))?(?:\s+(?:attachment|file))?(?:\s+(?:to|as)\s+[\p{L}\p{N}._-]+)?|(?:export\s+(?:as|to)|save\s+as)\s+[\p{L}\p{N}._-]+)\s*[.!]?$/iu,
  new RegExp(
    `^(?:请\\s*)?(?:不要|无需|不必|别|禁止|请勿)[^，,；;。.!！？?]{0,64}${CHINESE_TARGETED_CONVERSION_CLAUSE}\\s*[。.!！]?$`,
    'iu',
  ),
  new RegExp(
    `^(?:please\\s+)?(?:do\\s+not|don't|never)\\s+${ENGLISH_TARGETED_CONVERSION_CLAUSE}\\s*[.!]?$`,
    'iu',
  ),
]
const CONVERSION_TARGET = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])${CONVERSION_TARGET_PATTERN}(?=$|[^\\p{L}\\p{N}])`,
  'iu',
)
const CONTRASTIVE_ALTERNATIVE = /(?:而是|改成|改为|(?<!转)换成|(?<!转)换为|\binstead\b|\brather\b|\balternatively\b)/iu
const RESERVED_SUMMARY_LABEL = /(?:附\s*件|目\s*标\s*格\s*式)/iu
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

export function sanitizeDisplayName(value: string, index = 0): string {
  const fallback = `文件-${index + 1}`
  const trimmed = typeof value === 'string' ? value.trim() : ''
  const normalized = trimmed.normalize('NFKC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, '/')
    .replace(/[\p{M}\p{Lm}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, '')
  if (!normalized || /^(?:data:|https?:\/\/|file:)/iu.test(normalized)) return fallback
  const segments = normalized.split(/[\\/]+/gu)
    .map((segment) => segment.trim())
    .filter(Boolean)
  let name = segments.at(-1) ?? ''
  if (RESERVED_SUMMARY_LABEL.test(name)) return fallback
  name = [...name]
    .map((character) => /[\p{L}\p{N} ._()-]/u.test(character) ? character : '-')
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
  const normalized = text.trim()
  const hasAlternative = CONTRASTIVE_ALTERNATIVE.test(normalized)
  const conversionLike = CONVERSION_REQUEST.test(normalized)
    || TARGETED_CONVERSION_REQUEST.test(normalized)
    || (CONVERSION_TARGET.test(normalized) && hasAlternative)
  const fullyNegated = !hasAlternative
    && FULLY_NEGATED_CONVERSION_REQUESTS.some((pattern) => pattern.test(normalized))
  return conversionLike && !fullyNegated
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
