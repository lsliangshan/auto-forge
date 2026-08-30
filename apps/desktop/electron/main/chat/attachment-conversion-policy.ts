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
const IMAGE_REFERENCE_EDIT = /^(?:please\s+)?(?:(?:make|edit|transform)\s+(?:this|the)\s+image\s+(?:(?:look\s+)?(?:cinematic|watercolou?r|like\s+(?:a\s+)?sunset|like\s+(?:a\s+)?painting|like\s+(?:a\s+)?sketch))|create\s+(?:an?\s+)?new\s+image\s+based\s+on\s+(?:this|the)\s+image)(?:\s+please)?[.!?]?$|^(?:请)?(?:把)?(?:这个|这张|该|当前)?(?:图片|图像|照片)(?:做成|制作成?)(?:水彩画?|油画|素描|电影感|日落风格)[。！？]?$/iu
const ENGLISH_MEDIA_OUTPUT_REQUEST = /^(?:please\s+)?(?:make|create|generate|produce)\s+(?:an?\s+)?(?:[\p{L}\p{N}-]+\s+){0,6}(image|photo|audio|video)(?:\s+please)?[.!?]?$/iu
const CHINESE_MEDIA_OUTPUT_REQUEST = /^(?:请)?(?:生成|创建|制作)(?:一个|一张|一段)?(图片|图像|音频|视频)[。！？]?$/iu
const FILE_FORMAT_TARGET = /(?:\b\.?[a-z][a-z0-9]{1,15}\s+(?:file\s+format|format|version)\b|\.?[a-z0-9]{2,16}\s*(?:格式|版本))/iu
const MEDIA_FORMAT_TARGET = /\b(?:to|as|into)\s+(?:an?\s+)?\.?[a-z0-9][a-z0-9._+-]{1,15}\b|(?:转成|转为|导出为|保存为|生成为?)\s*\.?[a-z0-9][a-z0-9._+-]{1,15}\b/iu
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

export function hasHighConfidenceOrdinaryAttachmentRequest(text: string): boolean {
  const normalized = text.trim().normalize('NFKC')
  return ENGLISH_ORDINARY_REQUEST.test(normalized)
    || CHINESE_ORDINARY_REQUEST.test(normalized)
    || /^(?:please\s+)?what\s+format\s+is\s+(?:this|the|that)\s+(?:attachment|file|image|photo|document|pdf|jpe?g|png)\s*\??$/iu.test(normalized)
    || /^(?:请)?(?:这张|这个|该|当前)?(?:附件|文件|图片|图像|照片|文档|PDF|JPE?G|PNG)(?:是)?什么格式[？?]?$/iu.test(normalized)
    || /^(?:请)?(?:查看|读取|阅读)(?:一下)?(?:这个|这张|该|当前)?(?:附件|文件|图片|图像|照片|文档|PDF|JPE?G|PNG)(?:的)?(?:内容)?(?:，)?(?:并|然后)?(?:请)?告诉我(?:它的)?主要内容[。！？]?$/iu.test(normalized)
}

export function hasHighConfidenceMediaGenerationRequest(
  text: string,
): 'image' | 'audio' | 'video' | undefined {
  const normalized = text.trim().normalize('NFKC')
  if (MEDIA_FORMAT_TARGET.test(normalized)) return undefined
  const declared = (ENGLISH_MEDIA_OUTPUT_REQUEST.exec(normalized)?.[1]
    ?? CHINESE_MEDIA_OUTPUT_REQUEST.exec(normalized)?.[1]
  )?.toLocaleLowerCase('und')
  if (declared === 'image' || declared === 'photo' || declared === '图片' || declared === '图像') {
    return 'image'
  }
  if (declared === 'audio' || declared === '音频') return 'audio'
  if (declared === 'video' || declared === '视频') return 'video'
  return undefined
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
  const declaredMedia = hasHighConfidenceMediaGenerationRequest(text)
  if (declaredMedia !== undefined
    && context.requestedOutput !== 'auto'
    && context.requestedOutput !== declaredMedia) {
    return issueAccessDecision('ambiguous')
  }
  if ((declaredMedia === 'image' || declaredMedia === 'video')
    && context.attachmentKinds.some((kind) => kind !== 'image')) {
    return issueAccessDecision('ambiguous')
  }
  if (!context.hasAttachments) return issueAccessDecision('ordinary')
  if (decision === 'local') return issueAccessDecision('local')
  const imageReferenceEdit = decision === 'ordinary'
    && context.requestedOutput === 'image'
    && context.attachmentKinds.includes('image')
    && IMAGE_REFERENCE_EDIT.test(text)
    && !MEDIA_FORMAT_TARGET.test(text)
  if (imageReferenceEdit) return issueAccessDecision('ordinary')
  const explicitMediaOutput = decision === 'ordinary'
    && context.requestedOutput !== 'text'
    && declaredMedia !== undefined
    && (context.requestedOutput === 'auto' || declaredMedia === context.requestedOutput)
  if (explicitMediaOutput) return issueAccessDecision('ordinary')
  if (decision === 'ordinary' && hasHighConfidenceOrdinaryAttachmentRequest(text)) {
    return issueAccessDecision('ordinary')
  }
  return issueAccessDecision('ambiguous')
}
