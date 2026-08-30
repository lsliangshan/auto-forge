export type AttachmentConversionIntent = 'local' | 'ordinary' | 'ambiguous'

export interface ProviderAttachmentAccessDecision {
  readonly decision: AttachmentConversionIntent
  readonly allowProviderBytes: boolean
}

export interface ProviderAttachmentAccessContext {
  readonly hasAttachments: boolean
  readonly requestedOutput: 'auto' | 'text' | 'image' | 'audio' | 'video'
  readonly attachmentKinds: readonly ('image' | 'audio' | 'video' | 'file')[]
}

const CONVERSION_ACTION_RISK = /(?:转换|转成|转为|另存|保存(?:成|为)?|导出|输出(?:成|为)?|做成|制作|处理|改成|改为|换成|换为|变成|生成|万象转换)|\b(?:convert|conversion|converter|transcode|save|export|reformat|encode|render|transform)\b|\b(?:make|turn|change|process|create)\b[^,;.!?]{0,48}\b(?:(?:this|the|an?)\s+(?:attachment|file|image|photo|document|video|audio)|it|them)\b/iu
const BARE_CORRECTION_RISK = /(?:不要|不用|别)[^；;。.!！？?]{0,32}(?:而是|改成|改为|换成|换为)|\bnot\b[^;!?]{0,32}\bbut\b|\b(?:instead|rather)\b/iu
const ENGLISH_ORDINARY_CLAUSE = /^(?:please\s+)?(?:(?:describe|summari[sz]e|analy[sz]e|review|inspect|read|identify)\b.+|explain\s+(?:the\s+)?contents?\b.*|tell\s+me\b.*(?:content|what|format).*|what\s+(?:is|format)\b.*)$/iu
const CHINESE_ORDINARY_CLAUSE = /^(?:请)?(?:再)?(?:(?:查看|读取|阅读|描述|总结|概括|分析|识别|检查).+|告诉我.*(?:内容|是什么|格式)|.+是什么格式)$/u
const IMAGE_REFERENCE_EDIT = /(?:做成|制作成?)[^，,；;。.!！？?]{0,32}(?:水彩|油画|素描|电影感|日落)|\b(?:make|create|render|edit|transform)\b[^,;.!?]{0,64}\b(?:this|the)\s+image\b|\b(?:make|edit|transform)\s+(?:this|the)\s+image\b[^,;.!?]{0,48}\b(?:cinematic|watercolou?r|sunset|painting|sketch)\b/iu
const MEDIA_OUTPUT_REQUEST = /(?:生成|创建|制作)[^，,；;。.!！？?]{0,24}(?:图片|图像|音频|视频)|\b(?:make|create|generate|produce|edit)\s+(?:an?\s+)?(?:image|photo|audio|video)\b/iu
const FILE_FORMAT_TARGET = /(?:\b(?:to|as|into)\s+(?:an?\s+)?\.?[a-z][a-z0-9]{1,15}\b|\b\.?[a-z][a-z0-9]{1,15}\s+(?:format|version)\b|(?:成|为|转成|转为|导出为|保存为)\s*\.?[a-z0-9]{2,16}\b|\.?[a-z0-9]{2,16}\s*(?:格式|版本))/iu
function issueAccessDecision(decision: AttachmentConversionIntent): ProviderAttachmentAccessDecision {
  return Object.freeze({
    decision,
    allowProviderBytes: decision === 'ordinary',
  })
}

export function hasConversionRiskSignal(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[‘’]/gu, "'")
  return CONVERSION_ACTION_RISK.test(normalized)
    || BARE_CORRECTION_RISK.test(normalized)
    || FILE_FORMAT_TARGET.test(normalized)
}

function hasOrdinaryUnderstandingRequest(text: string): boolean {
  const clauses = text.normalize('NFKC')
    .split(/(?:[,;，；。.!！？?]+|\b(?:and|then|but)\b|然后|并且|并|但是)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
  return clauses.length > 0 && clauses.every((clause) => (
    ENGLISH_ORDINARY_CLAUSE.test(clause) || CHINESE_ORDINARY_CLAUSE.test(clause)
  ))
}

export function providerAttachmentAccess(
  decision: AttachmentConversionIntent,
  text: string,
  context: ProviderAttachmentAccessContext = {
    hasAttachments: true,
    requestedOutput: 'text',
    attachmentKinds: ['file'],
  },
): ProviderAttachmentAccessDecision {
  if (!context.hasAttachments) return issueAccessDecision('ordinary')
  if (decision === 'local') return issueAccessDecision('local')
  const imageReferenceEdit = context.requestedOutput === 'image'
    && context.attachmentKinds.includes('image')
    && IMAGE_REFERENCE_EDIT.test(text)
    && !FILE_FORMAT_TARGET.test(text)
  if (imageReferenceEdit) return issueAccessDecision('ordinary')
  const explicitMediaOutput = context.requestedOutput !== 'auto'
    && context.requestedOutput !== 'text'
    && MEDIA_OUTPUT_REQUEST.test(text)
    && !FILE_FORMAT_TARGET.test(text)
  if (explicitMediaOutput) return issueAccessDecision('ordinary')
  if (decision === 'ordinary'
    && hasOrdinaryUnderstandingRequest(text)
    && !hasConversionRiskSignal(text)) {
    return issueAccessDecision('ordinary')
  }
  return issueAccessDecision('ambiguous')
}
