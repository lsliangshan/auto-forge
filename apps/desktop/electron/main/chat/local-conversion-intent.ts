import { CONVERSION_TARGET_FORMATS } from '@autoforge/shared'

export interface LocalAttachmentProjection {
  index: number
  name: string
  mimeType: string
  byteSize: number
}

const CONVERSION_TARGET_PATTERN = `(?:${[...CONVERSION_TARGET_FORMATS, 'jpg'].join('|')})`
const CONVERSION_TARGET_REFERENCE = `\\.?${CONVERSION_TARGET_PATTERN}(?:(?:\\s*(?:格式|文件))|(?:\\s+(?:formats?|files?)))?(?=$|[^\\p{L}\\p{N}])`
const CONVERSION_TARGET_ARGUMENT = `(?:(?:一(?:个|份|张)|an?)\\s+)?${CONVERSION_TARGET_REFERENCE}`
const CHINESE_ATTACHMENT_REFERENCE = `(?:(?:(?:这|这个|该|当前|那|那个)?(?:张|个|份)?(?:附件|文件|图片|图像|照片|文档|视频|音频))|它们?)`
const ENGLISH_ATTACHMENT_REFERENCE = `(?:(?:(?:this|the|that|current|my|your|an?)\\s+)?(?:attachment|file|image|photo|picture|document|video|audio)|it|them)`
const EXPLICIT_CONVERSION_ACTION = new RegExp([
  `(?:转换|转|导出|输出|改|换)(?:成|为)\\s*${CONVERSION_TARGET_ARGUMENT}`,
  `另存为\\s*${CONVERSION_TARGET_ARGUMENT}`,
  `(?:做成|制作成)\\s*${CONVERSION_TARGET_ARGUMENT}`,
  `(?:保存|存)(?:\\s*${CHINESE_ATTACHMENT_REFERENCE})?\\s*(?:成|为)\\s*${CONVERSION_TARGET_ARGUMENT}`,
  `\\b(?:convert|transcode)(?:\\s+${ENGLISH_ATTACHMENT_REFERENCE})?\\s+(?:to|as)\\s+${CONVERSION_TARGET_ARGUMENT}`,
  `\\bmake\\s+${ENGLISH_ATTACHMENT_REFERENCE}\\s+(?:(?:into|as)\\s+)?${CONVERSION_TARGET_ARGUMENT}`,
  `\\b(?:save|export)\\s+${ENGLISH_ATTACHMENT_REFERENCE}\\s+(?:as|to)\\s+${CONVERSION_TARGET_ARGUMENT}`,
  `\\b(?:turn|change)\\s+${ENGLISH_ATTACHMENT_REFERENCE}\\s+(?:into|to|as)\\s+${CONVERSION_TARGET_ARGUMENT}`,
].join('|'), 'iu')
const CONVERSION_ACTION = /(?:万象转换|转换|转成|转为|导出为|另存为|做成|制作成|输出成|输出为|保存|存为|改成|改为|换成|换为|\bconvert\b|\btranscode\b|\bmake\b|\bsave\b|\bexport\b|\bturn\b|\bchange\b)/iu
const CONVERSION_NEGATION = /(?:(?:请\s*)?(?:千万\s*)?(?:不要|无需|不必|别|禁止|请勿)|(?:please\s+)?(?:do\s+not|don't|never))\s*/iu
const FORMAT_CAPABILITY_QUESTION = /(?:(?:哪些|什么|何种)\s*格式|\b(?:what|which)\s+formats?\b)/iu
const BARE_CONVERSION_TARGET = new RegExp(
  `^(?:(?:一(?:个|份|张)|an?)\\s+)?${CONVERSION_TARGET_REFERENCE}(?:\\s+(?:instead|rather))?$`,
  'iu',
)
const CONTRASTIVE_TARGET = /\b(?:instead|rather)\b/iu
const CLAUSE_CONNECTOR = /(?:而是|但是|然后|并且|但)|\b(?:and\s+then|but|however|then)\b/giu
const CLAUSE_SEPARATOR = new RegExp(
  `[，,；;。!！？?]|\\.(?!${CONVERSION_TARGET_PATTERN})`,
  'giu',
)
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
  const normalized = text.trim().normalize('NFKC').replace(/[‘’]/gu, "'")
  const clauses = normalized
    .replace(CLAUSE_CONNECTOR, ',')
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean)
  let sawNegatedConversion = false
  for (const clause of clauses) {
    const action = CONVERSION_ACTION.exec(clause)
    const explicit = EXPLICIT_CONVERSION_ACTION.exec(clause)
    const namedWorkflow = /万象转换/u.exec(clause)
    const actionIndex = explicit?.index ?? namedWorkflow?.index ?? action?.index
    const negated = actionIndex !== undefined
      && CONVERSION_NEGATION.test(clause.slice(0, actionIndex))
    if (negated && action) sawNegatedConversion = true
    const capabilityQuestion = FORMAT_CAPABILITY_QUESTION.test(clause)
    if (!capabilityQuestion && !negated && (explicit || namedWorkflow)) return true
    const bareTarget = BARE_CONVERSION_TARGET.test(clause)
    if (bareTarget && (sawNegatedConversion || CONTRASTIVE_TARGET.test(clause))) return true
  }
  return false
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
