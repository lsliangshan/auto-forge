import { describe, expect, it } from 'vitest'
import {
  hasLocalConversionIntent,
  projectLocalConversionPrompt,
  sanitizeDisplayName,
} from './local-conversion-intent.js'

const attachments = [{
  index: 0,
  name: 'report.pdf',
  mimeType: 'application/pdf',
  byteSize: 12,
}]

describe('local conversion intent', () => {
  it.each([
    '把附件转换成 PDF',
    '请将这个文件转为 webp',
    'convert this attachment to MP4',
    '用万象转换处理这个文件',
    '不要总结，把附件转换成 PDF',
    '不要转换成 Word，请转换成 PDF',
    "don't convert to Word; convert to PDF",
  ])('recognizes a current-attachment conversion request: %s', (text) => {
    expect(hasLocalConversionIntent(text, attachments)).toBe(true)
  })

  it.each([
    ['', attachments],
    ['总结这份 PDF', attachments],
    ['附件是什么格式？', attachments],
    ['不要转换这个附件', attachments],
    ["don't convert this attachment", attachments],
    ['把附件转换成 PDF', []],
  ] as const)('does not redact ordinary or attachment-free turns: %s', (text, currentAttachments) => {
    expect(hasLocalConversionIntent(text, currentAttachments)).toBe(false)
  })

  it('projects only sanitized current metadata with stable zero-based indexes', () => {
    const prompt = projectLocalConversionPrompt('把附件转为 PDF', [
      { index: 0, name: '../../data:secret\nreport.pdf', mimeType: 'application/pdf', byteSize: 12 },
      { index: 1, name: 'C:\\private\\CON ', mimeType: 'application/octet-stream', byteSize: 34 },
    ])

    expect(prompt).toBe([
      '把附件转为 PDF',
      '[附件 0: report.pdf, application/pdf, 12 bytes]',
      '[附件 1: 文件-2, application/octet-stream, 34 bytes]',
    ].join('\n'))
    expect(prompt).not.toMatch(/data:|secret|private|\\|\.\./i)
  })

  it.each([
    ['https://private.example/report.pdf', 0, '文件-1'],
    ['..\\..\\invoice.pdf. ', 1, 'invoice.pdf'],
    ['normal name.docx', 2, 'normal name.docx'],
    ['report\u202Egpj\u2066.pdf', 3, 'reportgpj.pdf'],
    ['invoice：目标格式：png.pdf', 4, '文件-5'],
    ['safe\u0000\n附件 9：other.pdf', 5, '文件-6'],
  ] as const)('sanitizes display name %s without exposing path-like prefixes', (name, index, expected) => {
    expect(sanitizeDisplayName(name, index)).toBe(expected)
  })
})
