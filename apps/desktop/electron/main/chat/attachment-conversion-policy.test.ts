import { describe, expect, it } from 'vitest'
import {
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
    ['make image', 'image'],
    ['make audio', 'audio'],
    ['make video', 'video'],
  ] as const)('treats an explicit %s output request as positive ordinary evidence', (text, requestedOutput) => {
    expect(providerAttachmentAccess('ordinary', text, {
      hasAttachments: true,
      requestedOutput,
      attachmentKinds: ['file'],
    })).toMatchObject({ decision: 'ordinary', allowProviderBytes: true })
  })

  it('defaults an attached request without positive ordinary evidence to ambiguous', () => {
    expect(providerAttachmentAccess('ordinary', 'please help', {
      hasAttachments: true,
      requestedOutput: 'text',
      attachmentKinds: ['image'],
    }).decision).toBe('ambiguous')
  })

  it.each([
    '总结这张图片',
    'Describe this image',
    '查看附件并告诉我主要内容',
    '这张图片是什么格式？',
    'process the conversation',
  ])('classifies a high-confidence attachment understanding request as ordinary: %s', (text) => {
    expect(classifyAttachmentConversionIntent(text, attachments)).toBe('ordinary')
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
