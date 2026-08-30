export type AttachmentConversionIntent = 'local' | 'ordinary' | 'ambiguous'

export interface ProviderAttachmentAccessDecision {
  decision: AttachmentConversionIntent
  allowProviderBytes: boolean
}

const CONVERSION_ACTION_RISK = /(?:转换|转成|转为|另存|保存(?:成|为)?|导出|输出(?:成|为)?|做成|制作|处理|改成|改为|换成|换为|万象转换)|\b(?:convert|conversion|converter|transcode|save|export)\b|\b(?:make|turn|change|process)\b[^,;.!?]{0,48}\b(?:(?:this|the|an?)\s+(?:attachment|file|image|photo|document|video|audio)|it|them)\b/iu
const BARE_CORRECTION_RISK = /(?:不要|不用|别)[^；;。.!！？?]{0,32}(?:而是|改成|改为|换成|换为)|\bnot\b[^;!?]{0,32}\bbut\b|\b(?:instead|rather)\b/iu

export function hasConversionRiskSignal(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/[‘’]/gu, "'")
  return CONVERSION_ACTION_RISK.test(normalized) || BARE_CORRECTION_RISK.test(normalized)
}

export function providerAttachmentAccess(
  decision: AttachmentConversionIntent,
  text: string,
): ProviderAttachmentAccessDecision {
  if (decision === 'ordinary' && !hasConversionRiskSignal(text)) {
    return { decision: 'ordinary', allowProviderBytes: true }
  }
  return {
    decision: decision === 'local' ? 'local' : 'ambiguous',
    allowProviderBytes: false,
  }
}
