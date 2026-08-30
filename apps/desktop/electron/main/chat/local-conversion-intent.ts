import { CONVERSION_TARGET_FORMATS } from '@autoforge/shared'
import {
  hasHighConfidenceOrdinaryAttachmentRequest,
  hasConversionRiskSignal,
  type AttachmentConversionIntent,
} from './attachment-conversion-policy.js'

export interface LocalAttachmentProjection {
  index: number
  name: string
  mimeType: string
  byteSize: number
}

const CHINESE_ATTACHMENT_REFERENCE = `(?:(?:(?:这|这个|该|当前|那|那个)?(?:张|个|份)?(?:附件|文件|图片|图像|照片|文档|视频|音频))|它们?)`
const ENGLISH_ATTACHMENT_REFERENCE = `\\b(?:(?:(?:this|the|that|current|my|your|an?)\\s+)?(?:attachment|file|image|photo|picture|document|video|audio)|it|them)\\b`
const ENGLISH_EXPLICIT_ATTACHMENT_REFERENCE = `\\b(?:(?:this|the|that|current|my|your|an?)\\s+(?:attachment|file|image|photo|picture|document|video|audio)|it|them)\\b`
const CHINESE_NAMED_ATTACHMENT_REFERENCE = `(?:(?:这|这个|该|当前|那|那个)?(?:张|个|份)?(?:附件|文件|图片|图像|照片|文档|视频|音频))`
const ENGLISH_NAMED_ATTACHMENT_REFERENCE = `\\b(?:(?:this|the|that|current|my|your|an?)\\s+)?(?:attachment|file|image|photo|picture|document|video|audio)\\b`
const FILENAME_REFERENCE_PATTERN = `[\\p{L}\\p{N}_+-][\\p{L}\\p{N}._+-]{0,63}\\.[A-Za-z0-9]{1,12}`
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
const HOW_TO_SCOPE = /(?:如何|怎么)|\bhow\s+to\b/iu
const OPEN_INFORMATION_QUESTION = /(?:(?:(?:请问)?(?:万象转换|这个工具|它|你)?(?:支持|能否|能不能|能|可以|能够))[^，,；;。.!！？?]{0,32}(?:哪些|什么|何种)\s*格式|(?:哪些|什么|何种)\s*格式|(?:介绍|说明|了解)[^，,；;。.!！？?]{0,24}(?:万象转换|转换)|(?:万象转换|转换)[^，,；;。.!！？?]{0,24}(?:是什么|什么意思|含义|安全|隐私|上传|能做什么|如何工作|怎么用)|\b(?:what\s+is|what\s+does|how\s+does|tell\s+me\s+about|describe|explain)[^,;.!?]{0,32}(?:conversion|converter|it)\b|\b(?:conversion|converter|it)\b[^,;.!?]{0,24}\b(?:safe|privacy|upload|mean)\b)/giu
const ENGLISH_OPEN_FORMAT_QUESTION = /\b(?:what|which)\s+formats?\b(?:(?!\b(?:and|or|but|then|while)\b|[,;.!?])[\s\S]){0,48}/giu
const ENGLISH_NO_MATTER_CAPABILITY = /^\s*no\s+matter\s+what\s+(?:this\s+(?:tool|converter)|it)\s+(?:can|could|does|will|would)\b[^,;.!?]{0,64}/giu
const ENGLISH_HOW_TO_QUESTION = /^\s*how\s+(?:do|can|could|would|should)\s+(?:i|we|you)\b[^,;.!?]{0,96}/giu
const CHINESE_HOW_TO_QUESTION = /^\s*(?:如何|怎么)[^，,；;。.!！？?]{0,96}/giu
const ENGLISH_ACTION_MOOD = /(?<capability>\b(?:can|could|does|do|will|would)\s+(?:this\s+(?:tool|converter)|it)\b)|(?<executable>\b(?:can|could|would)\s+you\b|\bi\s+(?:would|want|need)\b|\b(?:just|please|otherwise|then|directly)\b)/giu
const CHINESE_COMMAND_MOOD = /(?:然后|但是|但|请|直接|立即|马上)/gu
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
const GENERIC_FORMAT_TOKEN = `\\.?[A-Za-z0-9][A-Za-z0-9._+-]{1,14}`
const KNOWN_FORMAT_TOKENS = new Set([
  ...CONVERSION_TARGET_FORMATS,
  'jpg', 'zip', 'tif', 'docx', 'word', 'heic', 'svg', 'csv', 'txt', 'rar', '7z', 'cur',
].map((format) => format.toLowerCase()))
const CHINESE_CONTRASTIVE_COMMAND = new RegExp(
  `^(?:请\\s*)?(?:不要|不用|别)\\s*(?<source>${GENERIC_FORMAT_TOKEN})(?:\\s*格式)?\\s*(?:，|,|；|;)?\\s*(?:而是|改成|改为|换成|换为)\\s*(?<target>${GENERIC_FORMAT_TOKEN})(?:\\s*格式)?[。！!]?$`,
  'iu',
)
const ENGLISH_CONTRASTIVE_COMMAND = new RegExp(
  `^(?:please\\s*,?\\s*)?(?:not|do\\s+not\\s+use|don't\\s+use)\\s+(?<source>${GENERIC_FORMAT_TOKEN})\\s*(?:(?:[,;.]\\s*(?:an?\\s+)?(?<insteadTarget>${GENERIC_FORMAT_TOKEN})\\s+instead)|(?:but\\s+(?:an?\\s+)?(?<butTarget>${GENERIC_FORMAT_TOKEN})))(?:\\s*,?\\s*please)?[.!]?$`,
  'iu',
)
const CLAUSE_CONNECTOR = /(?:而是|但是|但)|\b(?:but|however)\b/giu
const CLAUSE_SEPARATOR = new RegExp(
  `(?:[，,；;](?!\\s*(?:或|和|并|以及|or\\b|and\\b))|[。!！？?])|…+|\\.(?![A-Za-z0-9]{2,10}\\b)`,
  'giu',
)
const UPPERCASE_FORMAT_REFERENCE = /(?:^|[^\p{L}\p{N}])\.?[A-Z0-9]{2,10}(?=$|[^\p{L}\p{N}])/u
const COORDINATED_ACTION_BRIDGE = /(?:或|和|及|以及|并|并且)\s*$|\b(?:or|and|nor)\s*$/iu
const EMBEDDED_ACTION_BRIDGE = /(?:或|和|及|以及|并|并且|然后)\s*$|\b(?:or|and|nor|then)\s*$/iu
const WEAK_CONTEXT_BOUNDARY = /(?:而是|但是|然后|解释|询问|问|总结|概括|介绍|说明|分析|描述|讨论|评价|检查|查看|读取)|\b(?:while|then|explain|ask|summari[sz]e|describe|discuss|analy[sz]e|review|check|read|tell)\b/giu
const FILENAME_REFERENCE = new RegExp(FILENAME_REFERENCE_PATTERN, 'giu')
const DIRECT_OBJECT_ENTITY = new RegExp(
  `(?<attachment>${CHINESE_NAMED_ATTACHMENT_REFERENCE}|${ENGLISH_NAMED_ATTACHMENT_REFERENCE}|__autoforge_filename__)|(?<nonattachment>(?:对话|聊天记录|聊天历史)|\\b(?:conversation|chat\\s+history)\\b)|(?<pronoun>(?:它们?)|\\b(?:it|them)\\b)`,
  'giu',
)
const RESERVED_SUMMARY_LABEL = /(?:附\s*件|目\s*标\s*格\s*式)/iu
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const REFERENCE_IMAGE_STYLE_EDIT = /(?:把)?(?:这个|这张|该|当前)?(?:图片|图像|照片)(?:做成|制作成?)[^，,；;。.!！？?]{0,24}(?:水彩|油画|素描|电影感|日落)|\b(?:make|edit|transform)\s+(?:this|the)\s+image\b[^,;.!?]{0,48}\b(?:cinematic|watercolou?r|sunset|painting|sketch)\b|\bcreate\s+(?:an?\s+)?new\s+image\s+based\s+on\s+(?:this|the)\s+image\b/iu

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
  if (HOW_TO_SCOPE.test(bridge)) return true
  return !ACTION_PIVOT.test(bridge)
}

function actionHasInformationalCapabilityMood(
  clause: string,
  previousActionEnd: number,
  actionIndex: number,
): boolean {
  const moods = [...clause.slice(previousActionEnd, actionIndex).matchAll(ENGLISH_ACTION_MOOD)]
  return moods.at(-1)?.groups?.capability !== undefined
}

function actionHasExplicitCommandMood(
  clause: string,
  previousActionEnd: number,
  actionIndex: number,
  hasAttachmentObject: boolean,
): boolean {
  if (!hasAttachmentObject) return false
  const prefix = clause.slice(previousActionEnd, actionIndex)
  const english = [...prefix.matchAll(ENGLISH_ACTION_MOOD)]
    .filter((mood) => mood.groups?.executable !== undefined)
    .at(-1)
  const chinese = [...prefix.matchAll(CHINESE_COMMAND_MOOD)].at(-1)
  const mood = english === undefined
    ? chinese
    : chinese === undefined || english.index >= chinese.index
      ? english
      : chinese
  if (mood?.index === undefined) return false
  const bridge = prefix.slice(mood.index + mood[0].length)
  return !OTHER_INTENT_BETWEEN_NEGATION_AND_ACTION.test(bridge)
    && !HOW_TO_SCOPE.test(bridge)
}

function formatTokenLike(value: string): boolean {
  const normalized = value.replace(/^\./u, '')
  return value.startsWith('.')
    || KNOWN_FORMAT_TOKENS.has(normalized.toLowerCase())
    || /^[A-Z][A-Z0-9]{1,14}$/u.test(normalized)
}

function hasEnglishContrastiveCommand(text: string): boolean {
  const match = ENGLISH_CONTRASTIVE_COMMAND.exec(text)
  const source = match?.groups?.source
  const target = match?.groups?.insteadTarget ?? match?.groups?.butTarget
  return source !== undefined
    && target !== undefined
    && formatTokenLike(source)
    && formatTokenLike(target)
}

function hasChineseContrastiveCommand(text: string): boolean {
  const match = CHINESE_CONTRASTIVE_COMMAND.exec(text)
  const source = match?.groups?.source
  const target = match?.groups?.target
  return source !== undefined
    && target !== undefined
    && formatTokenLike(source)
    && formatTokenLike(target)
}

type ExplicitObjectKind = 'attachment' | 'nonattachment'

interface ExplicitObjectSummary {
  kinds: Set<ExplicitObjectKind>
  hasExplicitAttachment: boolean
  lastKind?: ExplicitObjectKind
}

interface ActionOperandContext {
  text: string
  actionStart: number
  actionEnd: number
}

function shieldFilenameEntities(value: string): string {
  return value.replace(FILENAME_REFERENCE, (filename) => {
    const relation = /^(?:关于|围绕|包含|带有|来自)/u.exec(filename)?.[0] ?? ''
    return `${relation}__autoforge_filename__`
  })
}

function directObjectSpan(context: ActionOperandContext): string {
  const before = context.text.slice(0, context.actionStart)
  const chineseMarkers = [...before.matchAll(/(?:把|将)/gu)]
  const chineseMarker = chineseMarkers.at(-1)
  if (chineseMarker?.index !== undefined) {
    return before.slice(chineseMarker.index + chineseMarker[0].length)
  }

  const action = context.text.slice(context.actionStart, context.actionEnd)
  if (/\b(?:convert|transcode|save|export|process|make|turn|change)\b/iu.test(action)) {
    const candidate = shieldFilenameEntities(
      context.text.slice(context.actionStart)
        .replace(/^\s*(?:convert|transcode|save|export|process|make|turn|change)\b/iu, ''),
    ).replace(/\b(?:as\s+well\s+as|together\s+with)\b/giu, ' and ')
    const boundary = candidate.search(/\b(?:to|into|as|from|about|with|containing|including|convert|transcode|save|export|process|make|turn|change)\b/iu)
    return boundary < 0 ? candidate : candidate.slice(0, boundary)
  }

  const candidate = shieldFilenameEntities(context.text.slice(context.actionEnd))
  const boundary = candidate.search(/(?:为|成)/u)
  return boundary < 0 ? candidate : candidate.slice(0, boundary)
}

function explicitObjectSummary(
  span: string,
  previous: ExplicitObjectKind | undefined,
): ExplicitObjectSummary {
  const shielded = shieldFilenameEntities(span)
  const entities = [...shielded.matchAll(DIRECT_OBJECT_ENTITY)]
  const summary: ExplicitObjectSummary = { kinds: new Set(), hasExplicitAttachment: false }
  for (const [index, entity] of entities.entries()) {
    let kind: ExplicitObjectKind | undefined
    if (entity.groups?.attachment !== undefined) {
      const next = entities[index + 1]
      const prefix = shielded.slice(index === 0
        ? 0
        : (entities[index - 1]!.index ?? 0) + entities[index - 1]![0].length, entity.index)
      const bridge = next?.index === undefined
        ? ''
        : shielded.slice((entity.index ?? 0) + entity[0].length, next.index)
      const conversationModifier = next?.groups?.nonattachment !== undefined
        && /(?:关于|围绕|包含|带有|来自)\s*$/u.test(prefix)
        && /^\s*的?\s*$/u.test(bridge)
      if (!conversationModifier) {
        kind = 'attachment'
        summary.hasExplicitAttachment ||= entity[0] === '__autoforge_filename__'
          || /^(?:(?:这|这个|该|当前|那|那个)|(?:this|the|that|current|my|your)\b)/iu.test(entity[0])
      }
    } else if (entity.groups?.nonattachment !== undefined) {
      kind = 'nonattachment'
    } else if (entity.groups?.pronoun !== undefined) {
      kind = summary.lastKind ?? previous ?? 'attachment'
    }
    if (kind !== undefined) {
      summary.kinds.add(kind)
      summary.lastKind = kind
    }
  }
  return summary
}

function actionOperandContext(
  clause: string,
  actionIndex: number,
  actionEnd: number,
): ActionOperandContext {
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
  const action = clause.slice(actionIndex, actionEnd)
  return {
    text: `${prefix}${action}${suffix}`,
    actionStart: prefix.length,
    actionEnd: prefix.length + action.length,
  }
}

function clauseAntecedentSpan(clause: string): string {
  const english = /\b(?:review|check|read|describe|summari[sz]e|explain)\b/iu.exec(clause)
  if (english?.index !== undefined) {
    const candidate = clause.slice(english.index + english[0].length)
    const boundary = candidate.search(/\b(?:in|from|about|with|inside|within|containing|including)\b/iu)
    return boundary < 0 ? candidate : candidate.slice(0, boundary)
  }
  const chinese = /(?:查看|读取|描述|总结|概括|说明)/u.exec(clause)
  if (chinese?.index !== undefined) {
    const candidate = clause.slice(chinese.index + chinese[0].length)
    const boundary = candidate.search(/(?:所在|位于)/u)
    return boundary < 0 ? candidate : candidate.slice(0, boundary)
  }
  return clause
}

function weakActionHasConversionContext(context: string): boolean {
  return ATTACHMENT_REFERENCE.test(context)
    || FORMAT_LIKE_REFERENCE.test(context)
    || UPPERCASE_FORMAT_REFERENCE.test(context)
    || /万象转换/u.test(context)
}

interface InformationRangeCursor {
  readonly ranges: readonly RegExpMatchArray[]
  index: number
}

function informationRangeCursor(ranges: readonly RegExpMatchArray[]): InformationRangeCursor {
  return {
    ranges: [...ranges].sort((left, right) => (left.index ?? 0) - (right.index ?? 0)),
    index: 0,
  }
}

function actionFallsInsideInformationQuestion(
  actionIndex: number,
  cursor: InformationRangeCursor,
): boolean {
  while (cursor.index < cursor.ranges.length) {
    const range = cursor.ranges[cursor.index]!
    const start = range.index ?? 0
    const end = start + range[0].length
    if (actionIndex < end) return start <= actionIndex
    cursor.index += 1
  }
  return false
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

export function anonymizeAttachmentNames(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): string {
  const normalized = text.normalize('NFKC')
  const fold = (value: string): string => value
    .normalize('NFKD')
    .toLocaleLowerCase('und')
    .replace(/ß/gu, 'ss')
    .replace(/ς/gu, 'σ')
    .replace(/\p{Mark}/gu, '')
  const foldedParts: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let sourceOffset = 0
  for (const scalar of normalized) {
    const foldedScalar = fold(scalar)
    for (let index = 0; index < foldedScalar.length; index += 1) {
      foldedParts.push(foldedScalar[index]!)
      starts.push(sourceOffset)
      ends.push(sourceOffset + scalar.length)
    }
    sourceOffset += scalar.length
  }
  const foldedText = foldedParts.join('')
  const replacements: Array<{ start: number; end: number; text: string }> = []
  const expandedPathSpan = (start: number, end: number): { start: number; end: number } | undefined => {
    if (start === 0 || !/[\\/]/u.test(normalized[start - 1]!)) return undefined
    const prefix = normalized.slice(0, start)
    let boundary = 0
    for (const match of prefix.matchAll(/[,，;；。!?！？\n\r"'“”‘’]/gu)) {
      boundary = Math.max(boundary, (match.index ?? 0) + match[0].length)
    }
    for (const match of prefix.matchAll(/(?:\b(?:convert|transcode|save|export|reformat|encode|render|transform|create|generate|make|turn|change|process|use|read|open|describe|summari[sz]e)\b|(?:请把|转换|转成|转为|保存|导出|生成|创建|制作|处理|读取|查看|打开|把))\s+|\s+\b(?:and|or)\b\s+|(?:和|及|以及)\s*/giu)) {
      boundary = Math.max(boundary, (match.index ?? 0) + match[0].length)
    }
    while (/\s/u.test(normalized[boundary] ?? '')) boundary += 1
    const candidate = normalized.slice(boundary, end)
    return /[\\/]/u.test(candidate) ? { start: boundary, end } : undefined
  }
  const candidates = [...attachments].map((attachment) => ({
    attachment,
    basename: attachment.name.normalize('NFKC').split(/[\\/]/u).at(-1) ?? '',
  })).sort((left, right) => (
    fold(right.basename).length - fold(left.basename).length
  ))
  for (const { attachment, basename } of candidates) {
    const foldedName = fold(basename)
    if (!foldedName) continue
    let searchFrom = 0
    while (searchFrom <= foldedText.length - foldedName.length) {
      const found = foldedText.indexOf(foldedName, searchFrom)
      if (found === -1) break
      const start = starts[found]
      const end = ends[found + foldedName.length - 1]
      const span = start === undefined || end === undefined
        ? undefined
        : expandedPathSpan(start, end) ?? { start, end }
      if (span !== undefined && !replacements.some((replacement) => (
        replacement.start < span.end && replacement.end > span.start
      ))) {
        replacements.push({ ...span, text: `文件-${attachment.index + 1}` })
      }
      searchFrom = found + Math.max(1, foldedName.length)
    }
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce((value, replacement) => (
      value.slice(0, replacement.start) + replacement.text + value.slice(replacement.end)
    ), normalized)
}

export function hasLocalConversionIntent(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): boolean {
  if (attachments.length === 0 || !text.trim()) return false
  const normalized = text.trim().normalize('NFKC').replace(/[‘’]/gu, "'")
  if (hasChineseContrastiveCommand(normalized)
    || hasEnglishContrastiveCommand(normalized)) return true
  const clauses = normalized
    .replace(CLAUSE_CONNECTOR, ',')
    .split(CLAUSE_SEPARATOR)
    .map((clause) => clause.trim())
    .filter(Boolean)
  let sawNegatedConversion = false
  let previousExplicitObject: ExplicitObjectKind | undefined
  for (const clause of clauses) {
    const restartableInformationRanges = [
      ...clause.matchAll(ENGLISH_OPEN_FORMAT_QUESTION),
      ...clause.matchAll(ENGLISH_NO_MATTER_CAPABILITY),
    ]
    const informationRanges = [
      ...clause.matchAll(OPEN_INFORMATION_QUESTION),
      ...clause.matchAll(ENGLISH_HOW_TO_QUESTION),
      ...clause.matchAll(CHINESE_HOW_TO_QUESTION),
      ...restartableInformationRanges,
    ]
    const informationCursor = informationRangeCursor(informationRanges)
    const restartableInformationCursor = informationRangeCursor(restartableInformationRanges)
    let previousActionEnd = 0
    let previousActionWasNegated = false
    let previousActionWasEmbedded = false
    let previousActionWasInformational = false
    let sawAction = false
    for (const action of clause.matchAll(CONVERSION_ACTION)) {
      sawAction = true
      const actionIndex = action.index
      const actionEnd = actionIndex + action[0].length
      const actionBridge = clause.slice(previousActionEnd, actionIndex)
      const operandContext = actionOperandContext(clause, actionIndex, actionEnd)
      const objectSummary = explicitObjectSummary(
        directObjectSpan(operandContext),
        previousExplicitObject,
      )
      if (objectSummary.lastKind !== undefined) previousExplicitObject = objectSummary.lastKind
      const hasAttachmentObject = objectSummary.kinds.has('attachment')
      const hasAttachmentContext = hasAttachmentObject
        || previousExplicitObject === 'attachment'
      const explicitCommandMood = actionHasExplicitCommandMood(
        clause,
        previousActionEnd,
        actionIndex,
        hasAttachmentContext,
      )
      const capabilityInformation = actionHasInformationalCapabilityMood(
        clause,
        previousActionEnd,
        actionIndex,
      )
      const coordinatedInformation: boolean = previousActionWasInformational
        && COORDINATED_ACTION_BRIDGE.test(actionBridge)
      const explicitObjectRestart: boolean = coordinatedInformation
        && objectSummary.hasExplicitAttachment
      const informational: boolean = !explicitCommandMood && !explicitObjectRestart && (
        capabilityInformation
        || coordinatedInformation
        || actionFallsInsideInformationQuestion(actionIndex, informationCursor)
      )
      const restartableInformation = capabilityInformation
        || actionFallsInsideInformationQuestion(actionIndex, restartableInformationCursor)
      const embedded: boolean = !explicitCommandMood && !restartableInformation && (
        actionIsEmbeddedInOtherIntent(clause, previousActionEnd, actionIndex)
        || (previousActionWasEmbedded && (
          EMBEDDED_ACTION_BRIDGE.test(actionBridge)
          || HOW_TO_SCOPE.test(actionBridge)
        ))
      )
      previousActionWasEmbedded = embedded
      previousActionWasInformational = informational || embedded
      if (embedded) {
        previousActionEnd = actionEnd
        previousActionWasNegated = false
        continue
      }
      const negated = conversionActionIsNegated(
        clause,
        previousActionEnd,
        actionIndex,
        previousActionWasNegated,
      )
      previousActionEnd = actionEnd
      previousActionWasNegated = negated
      if (!hasAttachmentObject && objectSummary.kinds.has('nonattachment')) continue
      const strong = action.groups?.strong !== undefined
      if (!strong && !weakActionHasConversionContext(operandContext.text)) continue
      if (negated) {
        sawNegatedConversion = true
        continue
      }
      if (!informational) return true
    }
    const bareTarget = BARE_CONVERSION_TARGET.test(clause)
      || UPPERCASE_BARE_CONVERSION_TARGET.test(clause)
    if (bareTarget && (sawNegatedConversion || CONTRASTIVE_TARGET.test(clause))) return true
    if (!sawAction) {
      const clauseObject = explicitObjectSummary(clauseAntecedentSpan(clause), previousExplicitObject)
      if (clauseObject.lastKind !== undefined) previousExplicitObject = clauseObject.lastKind
    }
  }
  return false
}

export function classifyAttachmentConversionIntent(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): AttachmentConversionIntent {
  if (attachments.length === 0) return 'ordinary'
  const normalized = text.trim().normalize('NFKC').replace(/[‘’]/gu, "'")
  if (hasHighConfidenceOrdinaryAttachmentRequest(normalized)) return 'ordinary'
  if (REFERENCE_IMAGE_STYLE_EDIT.test(normalized)) return 'ordinary'
  const informationalScope = /^\s*(?:(?:can|could|does|do|will|would)\s+(?:this\s+(?:tool|converter)|it)\b|(?:如何|怎么))/iu.test(normalized)
  const explicitRestart = /\b(?:otherwise|then|directly|just|please)\b[^,;.!?]{0,48}\b(?:convert|transcode|save|export)\b|\b(?:i\s+(?:would|want|need)|(?:can|could|would)\s+you)\b[^,;.!?]{0,48}\b(?:convert|transcode|save|export)\b|(?:然后|但是|但|请|直接|立即|马上)[^，,；;。.!！？?]{0,32}(?:转换|转成|转为|另存|保存|导出|输出)/iu.test(normalized)
  if (informationalScope && !explicitRestart && hasConversionRiskSignal(normalized)) {
    return 'ambiguous'
  }
  if (hasLocalConversionIntent(text, attachments)) return 'local'
  return hasConversionRiskSignal(text) ? 'ambiguous' : 'ordinary'
}

export function projectLocalConversionPrompt(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): string {
  const lines = attachments.map((item) => (
    `[附件 ${item.index}: 文件-${item.index + 1}, ${item.mimeType}, ${item.byteSize} bytes]`
  ))
  return [anonymizeAttachmentNames(text, attachments), ...lines].filter(Boolean).join('\n')
}

export const AMBIGUOUS_CONVERSION_CLARIFICATION = '请确认要转换哪个附件，以及希望转换成什么格式。我尚未读取或转换附件内容。'

export function projectAmbiguousConversionPrompt(
  text: string,
  attachments: readonly LocalAttachmentProjection[],
): string {
  return projectLocalConversionPrompt(text, attachments)
}
