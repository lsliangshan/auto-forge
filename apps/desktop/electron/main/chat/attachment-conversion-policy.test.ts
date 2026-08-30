import { describe, expect, it } from 'vitest'
import {
  hasHighConfidenceMediaGenerationRequest,
  hasConversionRiskSignal,
  providerAttachmentAccess,
} from './attachment-conversion-policy.js'
import {
  classifyAttachmentConversionIntent,
  type LocalAttachmentProjection,
} from './local-conversion-intent.js'

const attachments: readonly LocalAttachmentProjection[] = [{
  index: 0,
  name: 'private-source.png',
  mimeType: 'image/png',
  byteSize: 12,
}]

describe('attachment conversion policy', () => {
  it.each([
    'No matter what this tool can convert then convert this attachment to PDF',
    'How do I convert PNG then convert this attachment to PDF',
    'How do I convert PNG then directly convert this attachment to PDF',
    '如何把图片转换为 PNG 然后请导出为 PDF',
    'Convert this conversation as well as this attachment to PDF',
    'Convert this conversation together with this attachment to PDF',
  ])('classifies an explicit attachment conversion as local: %s', (text) => {
    expect(classifyAttachmentConversionIntent(text, attachments)).toBe('local')
  })

  it.each([
    'Can this tool convert this attachment or save this image as JPG?',
    'Could it convert PDF or export this document as DOCX?',
    '怎么把这个图片保存为WebP或导出为PNG？',
    'Check the chat history containing this image, then export it as PDF',
    '不要把图片做成 ICO，只需总结它',
    'not foo but bar',
  ])('classifies conversion-risk uncertainty as ambiguous: %s', (text) => {
    expect(classifyAttachmentConversionIntent(text, attachments)).toBe('ambiguous')
  })

  it.each([
    'reformat this attachment as PDF',
    'encode this image as WebP',
    'render this document to PDF',
    'transform this file into DOCX',
    'create a PDF version of this attachment',
    '把这个附件变成PDF',
    '请生成这个附件的PDF版本',
  ])('defaults unknown attachment transformations to ambiguous: %s', (text) => {
    const classified = classifyAttachmentConversionIntent(text, attachments)
    expect(providerAttachmentAccess(classified, text, {
      hasAttachments: true,
      requestedOutput: 'text',
      attachmentKinds: ['image'],
    }).decision).toBe('ambiguous')
  })

  it.each([
    'describe this image, then reformat it as PDF',
    'summarize this attachment and encode it as WebP',
    'analyze this document; create a DOCX version of it',
    '查看这个附件，然后把它变成PDF',
    'transform this image into pdf',
    'render this image to jpg',
    'edit this image and export it as png',
  ])('does not let one understanding clause authorize a transformation clause: %s', (text) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput: 'text',
      attachmentKinds: ['image'],
    }).decision).toBe('ambiguous')
  })

  it.each([
    'describe this image while rasterizing it',
    '描述这个附件同时压缩它',
  ])('requires the entire ordinary-understanding request to match the allow grammar: %s', (text) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput: 'text',
      attachmentKinds: ['image'],
    }).decision).toBe('ambiguous')
  })

  it.each([
    'describe this image as bullet points',
    'describe this image as accurately as possible',
    'read this PDF as text',
  ])('allows a controlled ordinary output modifier without treating it as a format target: %s', (text) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput: 'text',
      attachmentKinds: ['file'],
    })).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it.each([
    'read this PDF',
    'describe this JPG',
    'summarize this PDF',
    '请阅读这个PDF',
    '再读取这个文本附件',
  ])('keeps a pure document-understanding request ordinary: %s', (text) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput: 'text',
      attachmentKinds: ['file'],
    })).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it.each([
    'make this image cinematic',
    'make this image watercolor',
    'make this image look like sunset',
    'create a new image based on this image',
    '把这个图片做成水彩画',
  ])('allows a positive reference-image edit as ordinary: %s', (text) => {
    const classified = classifyAttachmentConversionIntent(text, attachments)
    expect(providerAttachmentAccess(classified, text, {
      hasAttachments: true,
      requestedOutput: 'image',
      attachmentKinds: ['image'],
    })).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it.each([
    'transform this image into pdf',
    'render this image to jpg',
    'create this image as ico',
    'make this image into .heif',
    'render this image as JPEGXL',
  ])('does not let the reference-image exception authorize a format target: %s', (text) => {
    const classified = classifyAttachmentConversionIntent(text, attachments)
    const access = providerAttachmentAccess(classified, text, {
      hasAttachments: true,
      requestedOutput: 'image',
      attachmentKinds: ['image'],
    })
    expect(access.decision).not.toBe('ordinary')
    expect(access.allowProviderBytes).toBe(false)
  })

  it.each([
    'create this image in png',
    'create this image with png output',
    'generate an image with this image in foo format',
    '生成这个图片，格式为任意',
  ])('never upgrades an ambiguous classifier result through a media exception: %s', (text) => {
    expect(providerAttachmentAccess('ambiguous', text, {
      hasAttachments: true,
      requestedOutput: 'image',
      attachmentKinds: ['image'],
    })).toMatchObject({ decision: 'ambiguous', allowProviderBytes: false })
  })

  it('requires an ordinary classifier result even for an approved style sentence', () => {
    expect(providerAttachmentAccess('ambiguous', 'make this image watercolor', {
      hasAttachments: true,
      requestedOutput: 'image',
      attachmentKinds: ['image'],
    })).toMatchObject({ decision: 'ambiguous', allowProviderBytes: false })
  })

  it.each([
    ['生成一张图片', 'image'],
    ['制作一段视频', 'video'],
  ] as const)('classifies a strict Chinese %s generation request as ordinary positive evidence', (text, requestedOutput) => {
    const classified = classifyAttachmentConversionIntent(text, attachments)
    expect(classified).toBe('ordinary')
    expect(providerAttachmentAccess(classified, text, {
      hasAttachments: true,
      requestedOutput,
      attachmentKinds: ['image'],
    })).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it.each([
    ['generate an image', 'image'],
    ['Generate an IMAGE', 'image'],
    ['make audio', 'audio'],
    ['produce a short video', 'video'],
    ['生成一张图片', 'image'],
    ['创建一个音频', 'audio'],
    ['制作一段视频', 'video'],
  ] as const)('returns the declared media modality for %s', (text, expected) => {
    expect(hasHighConfidenceMediaGenerationRequest(text)).toBe(expected)
  })

  it.each([
    ['generate an image', 'image'], ['generate an image', 'audio'], ['generate an image', 'video'],
    ['make audio', 'image'], ['make audio', 'audio'], ['make audio', 'video'],
    ['produce a video', 'image'], ['produce a video', 'audio'], ['produce a video', 'video'],
  ] as const)('requires declared media in %s to match requested %s', (text, requestedOutput) => {
    const access = providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput,
      attachmentKinds: ['image'],
    })
    expect(access).toMatchObject(requestedOutput === hasHighConfidenceMediaGenerationRequest(text)
      ? { decision: 'ordinary', allowProviderBytes: true }
      : { decision: 'ambiguous', allowProviderBytes: false })
  })

  it.each(['image', 'audio', 'video'] as const)(
    'rejects a declared image request when a non-image attachment is routed to %s output',
    (requestedOutput) => {
      const access = providerAttachmentAccess('ordinary', 'generate an image', {
        hasAttachments: true,
        requestedOutput,
        attachmentKinds: ['file'],
      })
      expect(access.decision).toBe('ambiguous')
    },
  )

  it.each([
    ['generate an image', 'audio'], ['generate an image', 'video'],
    ['make audio', 'image'], ['make audio', 'video'],
    ['produce a video', 'image'], ['produce a video', 'audio'],
  ] as const)('fails closed on a declared/requested mismatch without attachments: %s to %s', (text, requestedOutput) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: false,
      requestedOutput,
      attachmentKinds: [],
    })).toMatchObject({ decision: 'ambiguous', allowProviderBytes: false })
  })

  it.each([
    ['generate an image', 'image', 'audio'],
    ['generate an image', 'image', 'video'],
    ['generate an image', 'image', 'file'],
    ['produce a video', 'video', 'audio'],
    ['produce a video', 'video', 'video'],
    ['produce a video', 'video', 'file'],
  ] as const)('rejects incompatible %s attachments before routing declared %s output', (text, requestedOutput, attachmentKind) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput,
      attachmentKinds: [attachmentKind],
    })).toMatchObject({ decision: 'ambiguous', allowProviderBytes: false })
  })

  it('keeps an image attachment compatible with declared image generation', () => {
    expect(providerAttachmentAccess('ordinary', 'generate an image', {
      hasAttachments: true,
      requestedOutput: 'image',
      attachmentKinds: ['image'],
    })).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it.each([
    '生成一张图片，格式为PNG',
    '制作一段视频，格式为任意',
    '生成一张图片并转换这个附件',
    '制作一段视频，然后描述附件',
  ])('does not classify a formatted or multi-predicate Chinese media request as ordinary: %s', (text) => {
    const classified = classifyAttachmentConversionIntent(text, attachments)
    expect(classified).not.toBe('ordinary')
    expect(providerAttachmentAccess(classified, text, {
      hasAttachments: true,
      requestedOutput: text.includes('视频') ? 'video' : 'image',
      attachmentKinds: ['image'],
    }).allowProviderBytes).toBe(false)
  })

  it.each([
    ['make image', 'image'],
    ['make audio', 'audio'],
    ['make video', 'video'],
  ] as const)('treats an explicit %s output request as positive ordinary evidence', (text, requestedOutput) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput,
      attachmentKinds: ['image'],
    })).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it('defaults an attached request without positive ordinary evidence to ambiguous', () => {
    expect(providerAttachmentAccess('ordinary', 'please help', {
      hasAttachments: true,
      requestedOutput: 'text',
      attachmentKinds: ['image'],
    }).decision).toBe('ambiguous')
  })

  it('does not treat auto output as media evidence when the prompt declares no modality', () => {
    expect(providerAttachmentAccess('ordinary', 'please help', {
      hasAttachments: true,
      requestedOutput: 'auto',
      attachmentKinds: ['image'],
    })).toMatchObject({ decision: 'ambiguous', allowProviderBytes: false })
  })

  it.each([
    '总结这张图片',
    'Describe this image',
    'What format is this image?',
    'What format is this file?',
    '查看附件并告诉我主要内容',
    '这张图片是什么格式？',
    'process the conversation',
  ])('classifies a high-confidence attachment understanding request as ordinary: %s', (text) => {
    expect(classifyAttachmentConversionIntent(text, attachments)).toBe('ordinary')
  })

  it.each([
    'What format is this image?',
    'What format is this file?',
    '这张图片是什么格式？',
    '查看附件并告诉我主要内容',
    '查看PDF并告诉我主要内容',
  ])('allows a complete high-confidence format/content understanding request: %s', (text) => {
    expect(providerAttachmentAccess(
      classifyAttachmentConversionIntent(text, attachments),
      text,
      { hasAttachments: true, requestedOutput: 'text', attachmentKinds: ['file'] },
    )).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it('classifies an attachment-free request as ordinary', () => {
    expect(classifyAttachmentConversionIntent('convert this file to PDF', [])).toBe('ordinary')
  })

  it('fails closed when a classifier mistakenly labels risky text ordinary', () => {
    expect(providerAttachmentAccess('ordinary', 'convert this attachment to PDF')).toEqual({
      decision: 'ambiguous',
      allowProviderBytes: false,
    })
    expect(providerAttachmentAccess('ordinary', '总结这张图片')).toEqual({
      decision: 'ordinary',
      allowProviderBytes: true,
    })
    expect(providerAttachmentAccess('ordinary', 'analyze this image, then reformat it as PDF')).toEqual({
      decision: 'ambiguous',
      allowProviderBytes: false,
    })
  })

  it('keeps the independent risk scan bounded on large input', () => {
    const text = `${'ordinary attachment context '.repeat(20_000)} convert this file`
    const startedAt = performance.now()
    expect(hasConversionRiskSignal(text)).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(250)
  })

  it('keeps classifier information-range matching linear-ish on a large request', () => {
    const text = `${'what formats convert and '.repeat(10_000)}then convert this attachment to PDF`
    const startedAt = performance.now()
    expect(classifyAttachmentConversionIntent(text, attachments)).toBe('local')
    expect(performance.now() - startedAt).toBeLessThan(750)
  })
})
