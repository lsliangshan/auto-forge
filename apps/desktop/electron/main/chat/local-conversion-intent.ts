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
const STRONG_CONVERSION_ACTION = [
  `(?<!万象)(?:转换|转成|转为)(?!率|器)`,
  `(?:另存(?:为)?|(?:保存|存|导出|输出|改|换)(?:成|为))`,
  `万象转换\\s*(?:来\\s*)?处理`,
  `\\b(?:convert|transcode)\\b`,
  `\\b(?:save|export)(?:\\s+${ENGLISH_EXPLICIT_ATTACHMENT_REFERENCE})?\\s+as\\b`,
  `\\b(?:make|turn|change)\\s+${ENGLISH_EXPLICIT_ATTACHMENT_REFERENCE}\\b`,
].join('|')
const WEAK_CONVERSION_ACTION = [
  `(?:做成|制作|保存|导出|输出|处理)`,
  `\\b(?:save|export|process)\\b`,
].join('|')
const CONVERSION_ACTION = new RegExp(
  `(?<strong>${STRONG_CONVERSION_ACTION})|(?<weak>${WEAK_CONVERSION_ACTION})`,
  'giu',
)
const ATTACHMENT_REFERENCE = new RegExp(
  `(?:${CHINESE_ATTACHMENT_REFERENCE}|${ENGLISH_ATTACHMENT_REFERENCE})`,
  'iu',
)
const CONVERSION_NEGATION = /(?:不要|不用|不需要|无需|不必|别|禁止|请勿)|\b(?:do\s+not|don't|never|no\s+need\s+to|do\s+not\s+need\s+to|don't\s+need\s+to|need\s+not|needn't)\b/giu
const OTHER_INTENT_BETWEEN_NEGATION_AND_ACTION = /(?:解释|询问|问|总结|概括|介绍|说明|分析|描述|讨论|评价|检查|查看|读取)|\b(?:explain|ask|summari[sz]e|describe|discuss|analy[sz]e|review|check|read|tell)\b/iu
const ACTION_EMBEDDING_OTHER_INTENT = /(?:解释|总结|概括|介绍|说明|分析|描述|讨论|评价|检查|查看|读取)|\b(?:explain|summari[sz]e|describe|discuss|analy[sz]e|review|check|read)\b/giu
const ACTION_PIVOT = /(?:直接|立即|马上|以及|并且|并|同时|然后|而是|或)|\b(?:just|and|or|then|but|instead)\b/iu
const OPEN_INFORMATION_QUESTION = /(?:(?:(?:请问)?(?:万象转换|这个工具|它|你)?(?:支持|能否|能不能|能|可以|能够))[^，,；;。.!！？?]{0,32}(?:哪些|什么|何种)\s*格式|(?:哪些|什么|何种)\s*格式|(?:介绍|说明|了解)[^，,；;。.!！？?]{0,24}(?:万象转换|转换)|(?:万象转换|转换)[^，,；;。.!！？?]{0,24}(?:是什么|什么意思|含义|安全|隐私|上传|能做什么|如何工作|怎么用)|\b(?:what\s+is|what\s+does|how\s+does|tell\s+me\s+about|describe|explain)[^,;.!?]{0,32}(?:conversion|converter|it)\b|\b(?:conversion|converter|it)\b[^,;.!?]{0,24}\b(?:safe|privacy|upload|mean)\b)/giu
const ENGLISH_OPEN_FORMAT_QUESTION = /\b(?:what|which)\s+formats?\b(?:(?!\b(?:and|but|then|while)\b|[,;.!?])[\s\S]){0,48}/giu
const BARE_TARGET_PATTERN = `(?:${[
  ...CONVERSION_TARGET_FORMATS,
  'jpg', 'zip', 'tif', 'docx', 'word', 'heic', 'svg', 'csv', 'txt', 'rar', '7z', 'cur',
].join('|')})`
const FORMAT_LIKE_REFERENCE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])\\.?${BARE_TARGET_PATTERN}(?=$|[^\\p{L}\\p{N}])`,
  'iu',
)
const BARE_CONVERSION_TARGET = new RegExp(
  `^(?:(?:一(?:个|份|张)|an?)\\s+)?\\.?${BARE_TARGET_PATTERN}(?:(?:\\s*(?:格式|文件))|(?:\\s+(?:formats?|files?)))?(?:\\s+(?:instead|rather))?$`,
  'iu',
)
const UPPERCASE_BARE_CONVERSION_TARGET = /^(?:(?:an?)\s+)?\.?[A-Z0-9]{2,10}(?:\s+(?:FORMAT|FILE))?(?:\s+(?:instead|rather))?$/u
const CONTRASTIVE_TARGET = /\b(?:instead|rather)\b/iu
const FORMAT_SHORTHAND = `\\.?${BARE_TARGET_PATTERN}`
const CHINESE_CONTRASTIVE_SHORTHAND = new RegExp(
  `(?:不要|不用|别)\\s*${FORMAT_SHORTHAND}\\s*(?:，|,|；|;)?\\s*(?:而是|改成|改为|换成|换为)\\s*${FORMAT_SHORTHAND}`,
  'iu',
)
const ENGLISH_CONTRASTIVE_SHORTHAND = new RegExp(
  `^(?:not|do\\s+not\\s+use|don't\\s+use)\\s+${FORMAT_SHORTHAND}\\s*(?:(?:[,;.]\\s*(?:an?\\s+)?${FORMAT_SHORTHAND}\\s+instead)|(?:but\\s+(?:an?\\s+)?${FORMAT_SHORTHAND}))$`,
  'iu',
)
const CLAUSE_CONNECTOR = /(?:而是|但是|然后|并且|但)|\b(?:and\s+then|but|however|then)\b/giu
const CLAUSE_SEPARATOR = new RegExp(
  `(?:[，,；;](?!\\s*(?:或|or\\b))|[。!！？?])|…+|\\.(?![A-Za-z0-9]{2,10}\\b)`,
  'giu',
)
const UPPERCASE_FORMAT_REFERENCE = /(?:^|[^\p{L}\p{N}])\.?[A-Z0-9]{2,10}(?=$|[^\p{L}\p{N}])/u
const COORDINATED_ACTION_BRIDGE = /(?:或|和|及|以及|并|并且)\s*$|\b(?:or|and|nor)\s*$/iu
const WEAK_CONTEXT_BOUNDARY = /(?:而是|但是|然后|并且|同时|以及|并|和|或|解释|询问|问|总结|概括|介绍|说明|分析|描述|讨论|评价|检查|查看|读取)|\b(?:and|or|while|then|explain|ask|summari[sz]e|describe|discuss|analy[sz]e|review|check|read|tell)\b/giu
const NON_ATTACHMENT_OBJECT = /(?:对话|聊天记录|聊天历史)|\b(?:conversation|chat\s+history)\b/iu
const RESERVED_SUMMARY_LABEL = /(?:附\s*件|目\s*标\s*格\s*式)/iu
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function conversionActionIsNegated(
  clause: string,
  start: number,
  actionIndex: number,
  previousActionWasNegated: boolean,
): boolean {
  const prefix = clause.slice(start, actionIndex)
  const negations = [...prefix.matchAll(CONVERSION_NEGATION)]
  const negation = negations.at(-1)
  if (negation?.index !== undefined) {
    const bridge = prefix.slice(negation.index + negation[0].length)
    return !OTHER_INTENT_BETWEEN_NEGATION_AND_ACTION.test(bridge)
  }
  return previousActionWasNegated
    && COORDINATED_ACTION_BRIDGE.test(prefix)
    && !OTHER_INTENT_BETWEEN_NEGATION_AND_ACTION.test(prefix)
}

function actionIsEmbeddedInOtherIntent(clause: string, start: number, actionIndex: number): boolean {
  const prefix = clause.slice(start, actionIndex)
  const otherIntent = [...prefix.matchAll(ACTION_EMBEDDING_OTHER_INTENT)].at(-1)
  if (otherIntent?.index === undefined) return false
  const bridge = prefix.slice(otherIntent.index + otherIntent[0].length)
  return !ACTION_PIVOT.test(bridge)
}

function actionOperandContext(clause: string, actionIndex: number, actionEnd: number): string {
  const prefixWindow = clause.slice(Math.max(0, actionIndex - 48), actionIndex)
  const prefixBoundaries = [...prefixWindow.matchAll(WEAK_CONTEXT_BOUNDARY)]
  const lastPrefixBoundary = prefixBoundaries.at(-1)
  const prefix = lastPrefixBoundary?.index === undefined
    ? prefixWindow
    : prefixWindow.slice(lastPrefixBoundary.index + lastPrefixBoundary[0].length)
  const suffixWindow = clause.slice(actionEnd, actionEnd + 48)
  const suffixBoundary = [...suffixWindow.matchAll(WEAK_CONTEXT_BOUNDARY)].at(0)
  const suffix = suffixBoundary?.index === undefined
    ? suffixWindow
    : suffixWindow.slice(0, suffixBoundary.index)
  return `${prefix}${clause.slice(actionIndex, actionEnd)}${suffix}`
}

function weakActionHasConversionContext(context: string): boolean {
  return ATTACHMENT_REFERENCE.test(context)
    || FORMAT_LIKE_REFERENCE.test(context)
    || UPPERCASE_FORMAT_REFERENCE.test(context)
    || /万象转换/u.test(context)
}

function actionFallsInsideInformationQuestion(
  actionIndex: number,
  informationRanges: readonly RegExpMatchArray[],
): boolean {
  return informationRanges.some((information) => (
    information.index !== undefined
    && information.index <= actionIndex
    && actionIndex < information.index + information[0].length
  ))
}

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
  if (CHINESE_CONTRASTIVE_SHORTHAND.test(normalized)
    || ENGLISH_CONTRASTIVE_SHORTHAND.test(normalized)) return true
  const clauses = normalized
    .replace(CLAUSE_CONNECTOR, ',')
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean)
  let sawNegatedConversion = false
  for (const clause of clauses) {
    const informationRanges = [
      ...clause.matchAll(OPEN_INFORMATION_QUESTION),
      ...clause.matchAll(ENGLISH_OPEN_FORMAT_QUESTION),
    ]
    let previousActionEnd = 0
    let previousActionWasNegated = false
    for (const action of clause.matchAll(CONVERSION_ACTION)) {
      const actionIndex = action.index
      if (actionIsEmbeddedInOtherIntent(clause, previousActionEnd, actionIndex)) {
        previousActionEnd = actionIndex + action[0].length
        previousActionWasNegated = false
        continue
      }
      const negated = conversionActionIsNegated(
        clause,
        previousActionEnd,
        actionIndex,
        previousActionWasNegated,
      )
      previousActionEnd = actionIndex + action[0].length
      previousActionWasNegated = negated
      const operandContext = actionOperandContext(clause, actionIndex, previousActionEnd)
      if (NON_ATTACHMENT_OBJECT.test(operandContext)) continue
      const strong = action.groups?.strong !== undefined
      if (!strong && !weakActionHasConversionContext(operandContext)) continue
      if (negated) {
        sawNegatedConversion = true
        continue
      }
      if (!actionFallsInsideInformationQuestion(actionIndex, informationRanges)) return true
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
