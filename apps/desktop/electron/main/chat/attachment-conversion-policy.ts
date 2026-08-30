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

const CONVERSION_ACTION_RISK = /(?:转换|转成|转为|另存|保存(?:成|为)?|导出|输出(?:成|为)?|做成|制作|处理|改成|改为|换成|换为|万象转换)|\b(?:convert|conversion|converter|transcode|save|export)\b|\b(?:make|turn|change|process)\b[^,;.!?]{0,48}\b(?:(?:this|the|an?)\s+(?:attachment|file|image|photo|document|video|audio)|it|them)\b/iu
const BARE_CORRECTION_RISK = /(?:不要|不用|别)[^；;。.!！？?]{0,32}(?:而是|改成|改为|换成|换为)|\bnot\b[^;!?]{0,32}\bbut\b|\b(?:instead|rather)\b/iu
const ORDINARY_UNDERSTANDING = /(?:查看|读取|描述|总结|概括|分析|识别|检查|告诉我[^，,；;。.!！？?]{0,24}(?:内容|是什么|格式)|是什么格式)|\b(?:describe|summari[sz]e|analy[sz]e|review|inspect|read|identify|explain\s+(?:the\s+)?contents?|what\s+(?:is|format))\b/iu
const IMAGE_REFERENCE_EDIT = /(?:做成|制作成?)[^，,；;。.!！？?]{0,32}(?:水彩|油画|素描|电影感|日落)|\b(?:make|create|render|edit|transform)\b[^,;.!?]{0,64}\b(?:this|the)\s+image\b|\b(?:make|edit|transform)\s+(?:this|the)\s+image\b[^,;.!?]{0,48}\b(?:cinematic|watercolou?r|sunset|painting|sketch)\b/iu
const MEDIA_OUTPUT_REQUEST = /(?:生成|创建|制作)[^，,；;。.!！？?]{0,24}(?:图片|图像|音频|视频)|\b(?:make|create|generate|produce|edit)\s+(?:an?\s+)?(?:image|photo|audio|video)\b/iu
const FILE_FORMAT_TARGET = /(?:\.[a-z0-9]{2,12}\b|(?:PDF|PNG|JPE?G|WEBP|AVIF|ICO|ICNS|HEI[CF]|TIFF?|BMP|GIF|SVG|DOCX?|XLSX?|PPTX?|CSV|TXT|ZIP|RAR|7Z)\b|(?:PDF|PNG|JPG|JPEG|WebP|AVIF|ICO|ICNS|HEIF|HEIC|TIFF?|BMP|GIF|SVG|DOCX?|XLSX?|PPTX?|CSV|TXT|ZIP|RAR|7Z)\s*(?:格式|版本))/u
const issuedAccessDecisions = new WeakSet<object>()

export function isIssuedProviderAttachmentAccessDecision(
  value: ProviderAttachmentAccessDecision | undefined,
): value is ProviderAttachmentAccessDecision {
  return value !== undefined && issuedAccessDecisions.has(value)
}

function issueAccessDecision(decision: AttachmentConversionIntent): ProviderAttachmentAccessDecision {
  const issued = Object.freeze({
    decision,
    allowProviderBytes: decision === 'ordinary',
  })
  issuedAccessDecisions.add(issued)
  return issued
}

export function hasConversionRiskSignal(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[‘’]/gu, "'")
  return CONVERSION_ACTION_RISK.test(normalized)
    || BARE_CORRECTION_RISK.test(normalized)
    || FILE_FORMAT_TARGET.test(normalized)
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
  if (decision === 'local') return issueAccessDecision('local')
  if (decision === 'ordinary'
    && ORDINARY_UNDERSTANDING.test(text)
    && !hasConversionRiskSignal(text)) {
    return issueAccessDecision('ordinary')
  }
  return issueAccessDecision('ambiguous')
}
