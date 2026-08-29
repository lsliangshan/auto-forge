import { CONVERSION_TARGET_FORMATS } from '@autoforge/shared'

export interface LocalAttachmentProjection {
  index: number
  name: string
  mimeType: string
  byteSize: number
}

const CHINESE_ATTACHMENT_REFERENCE = `(?:(?:(?:这|这个|该|当前|那|那个)?(?:张|个|份)?(?:附件|文件|图片|图像|照片|文档|视频|音频))|它们?)`
const ENGLISH_ATTACHMENT_REFERENCE = `(?:(?:(?:this|the|that|current|my|your|an?)\\s+)?(?:attachment|file|image|photo|picture|document|video|audio)|it|them)`
const ENGLISH_EXPLICIT_ATTACHMENT_REFERENCE = `(?:(?:this|the|that|current|my|your|an?)\\s+(?:attachment|file|image|photo|picture|document|video|audio)|it|them)`
const CONVERSION_ACTION = new RegExp([
  `(?<!万象)(?:转换|转成|转为)`,
  `(?:做成|制作|保存|存为|另存|导出|输出(?:成|为)|改成|改为|换成|换为)`,
  `万象转换\\s*(?:来\\s*)?处理`,
  `处理\\s*${CHINESE_ATTACHMENT_REFERENCE}`,
  `\\b(?:transcode|convert|export)\\b`,
  `\\bsave(?:\\s+${ENGLISH_EXPLICIT_ATTACHMENT_REFERENCE})?(?:\\s+as)?\\b`,
  `\\b(?:make|turn|change)\\s+${ENGLISH_EXPLICIT_ATTACHMENT_REFERENCE}\\b`,
].join('|'), 'iu')
const CHINESE_NEGATED_ACTION_PREFIX = new RegExp(
  `(?:请\\s*)?(?:千万\\s*)?(?:不要|不用|不需要|无需|不必|别|禁止|请勿)\\s*(?:(?:再|直接|继续|尝试)\\s*)?(?:把|将|用)?\\s*(?:${CHINESE_ATTACHMENT_REFERENCE}\\s*)?$`,
  'iu',
)
const ENGLISH_NEGATED_ACTION_PREFIX = new RegExp(
  `(?:please\\s+)?(?:you\\s+)?(?:do\\s+not|don't|never|no\\s+need\\s+to|do\\s+not\\s+need\\s+to|don't\\s+need\\s+to|need\\s+not|needn't)\\s*(?:ever\\s+)?(?:${ENGLISH_ATTACHMENT_REFERENCE}\\s*)?$`,
  'iu',
)
const CHINESE_INFORMATION_PREFIX = /(?:支持|是否|能否|可否|能不能|可以|能够|请问|如何|怎么|介绍|说明|了解|安全|隐私|万象转换能|这个工具能|它能|你能)/iu
const ENGLISH_INFORMATION_PREFIX = /\b(?:what|which|how|whether|can|could|would|does|is|tell|describe|explain)\b/iu
const BARE_TARGET_PATTERN = `(?:${[
  ...CONVERSION_TARGET_FORMATS,
  'jpg', 'zip', 'tif', 'docx', 'word', 'heic', 'svg', 'csv', 'txt',
].join('|')})`
const BARE_CONVERSION_TARGET = new RegExp(
  `^(?:(?:一(?:个|份|张)|an?)\\s+)?\\.?${BARE_TARGET_PATTERN}(?:(?:\\s*(?:格式|文件))|(?:\\s+(?:formats?|files?)))?(?:\\s+(?:instead|rather))?$`,
  'iu',
)
const UPPERCASE_BARE_CONVERSION_TARGET = /^(?:(?:an?)\s+)?\.?[A-Z0-9]{2,10}(?:\s+(?:FORMAT|FILE))?(?:\s+(?:instead|rather))?$/u
const CONTRASTIVE_TARGET = /\b(?:instead|rather)\b/iu
const CLAUSE_CONNECTOR = /(?:而是|但是|然后|并且|但)|\b(?:and\s+then|and|but|however|then)\b/giu
const CLAUSE_SEPARATOR = new RegExp(
  `[，,；;。!！？?]|…+|\\.(?![A-Za-z0-9]{2,10}\\b)`,
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
    if (action) {
      const prefix = clause.slice(0, action.index)
      const negated = CHINESE_NEGATED_ACTION_PREFIX.test(prefix)
        || ENGLISH_NEGATED_ACTION_PREFIX.test(prefix)
      if (negated) sawNegatedConversion = true
      const informational = CHINESE_INFORMATION_PREFIX.test(prefix)
        || ENGLISH_INFORMATION_PREFIX.test(prefix)
      if (!negated && !informational) return true
    }
    const bareTarget = BARE_CONVERSION_TARGET.test(clause)
      || UPPERCASE_BARE_CONVERSION_TARGET.test(clause)
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
