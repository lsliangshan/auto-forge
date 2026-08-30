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
const ENGLISH_ORDINARY_OBJECT = String.raw`(?:(?:this|the|that|an?|current|attached)\s+)?(?:[\p{L}\p{N}_-]+\s+){0,2}(?:attachment|file|image|photo|document|video|audio|text|pdf|jpe?g|png)`
const ENGLISH_ORDINARY_MODIFIER = String.raw`(?:\s+(?:briefly|carefully)|\s+as\s+(?:bullet\s+points?|a\s+bulleted\s+list|plain\s+text|text|accurately\s+as\s+possible))*`
const ENGLISH_ORDINARY_REQUEST = new RegExp(
  String.raw`^(?:please\s+)?(?:(?:describe|summari[sz]e|analy[sz]e|review|inspect|read|identify)\s+${ENGLISH_ORDINARY_OBJECT}|explain\s+(?:the\s+)?contents?\s+of\s+${ENGLISH_ORDINARY_OBJECT}|tell\s+me\s+(?:what\s+is\s+in|the\s+contents?\s+of|what\s+format)\s+${ENGLISH_ORDINARY_OBJECT})${ENGLISH_ORDINARY_MODIFIER}(?:\s+please)?[.!?]?$`,
  'iu',
)
const CHINESE_ORDINARY_REQUEST = /^(?:请)?(?:再)?(?:查看|读取|阅读|描述|总结|概括|分析|识别|检查)(?:一下)?(?:这个|这张|该|当前)?(?:文本)?(?:附件|图片|图像|照片|文件|文档|PDF|JPE?G|PNG)(?:的)?(?:内容|页面)?(?:，?请)?(?:简要|仔细|准确)?(?:说明|描述|总结)?[。！？]?$/iu
const IMAGE_REFERENCE_EDIT = /(?:做成|制作成?)[^，,；;。.!！？?]{0,32}(?:水彩|油画|素描|电影感|日落)|\b(?:make|create|render|edit|transform)\b[^,;.!?]{0,64}\b(?:this|the)\s+image\b|\b(?:make|edit|transform)\s+(?:this|the)\s+image\b[^,;.!?]{0,48}\b(?:cinematic|watercolou?r|sunset|painting|sketch)\b/iu
const MEDIA_OUTPUT_REQUEST = /(?:生成|创建|制作)[^，,；;。.!！？?]{0,48}(?:图片|图像|音频|视频)|\b(?:make|create|generate|produce|edit)\b[^,;.!?]{0,48}\b(?:image|photo|audio|video)\b/iu
const FILE_FORMAT_TARGET = /(?:\b\.?[a-z][a-z0-9]{1,15}\s+(?:file\s+format|format|version)\b|\.?[a-z0-9]{2,16}\s*(?:格式|版本))/iu
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
  const normalized = text.trim().normalize('NFKC')
  return ENGLISH_ORDINARY_REQUEST.test(normalized) || CHINESE_ORDINARY_REQUEST.test(normalized)
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
