import { describe, expect, it } from 'vitest'
import {
  anonymizeAttachmentNames,
  classifyAttachmentConversionIntent,
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
    ['No matter what this tool can convert then convert this attachment to PDF', 'local'],
    ['How do I convert PNG then convert this attachment to PDF', 'local'],
    ['How do I convert PNG then directly convert this attachment to PDF', 'local'],
    ['如何把图片转换为 PNG 然后请导出为 PDF', 'local'],
    ['Convert this conversation as well as this attachment to PDF', 'local'],
    ['Convert this conversation together with this attachment to PDF', 'local'],
    ['Can this tool convert this attachment or save this image as JPG?', 'ambiguous'],
    ['Could it convert PDF or export this document as DOCX?', 'ambiguous'],
    ['怎么把这个图片保存为WebP或导出为PNG？', 'ambiguous'],
    ['Check the chat history containing this image, then export it as PDF', 'ambiguous'],
  ] as const)('classifies final attachment review case %s as %s', (text, expected) => {
    expect(classifyAttachmentConversionIntent(text, attachments)).toBe(expected)
  })

  it.each([
    '把附件转换成 PDF',
    '请将这个文件转为 webp',
    'convert this attachment to MP4',
    '用万象转换处理这个文件',
    '不要总结，把附件转换成 PDF',
    '不要转换成 Word，请转换成 PDF',
    "don't convert to Word; convert to PDF",
    '不要转换成 Word，而是 PDF',
    '不要转换成Word而是PDF',
    "don't convert to Word; PDF instead",
    '改为 PDF',
    'PDF instead',
    '把图片做成 ico',
    '把图片保存为 webp',
    '将这张照片制作成 ICNS',
    '保存这个文件为 xlsx',
    '把附件存为 PDF',
    'make this image an ICO',
    'make the attachment into WebP',
    'save this image as PNG',
    'turn this photo into AVIF',
    'change the file to GIF',
    '把图片制作成ICO格式',
    '把图片做成一个 ICO',
    '将图片保存成 .ico',
    '把图片保存为 JPG',
    'make this image into an ICO file',
    '支持转换成哪些格式？请把图片转成 PDF',
    'What formats are supported? Save it as WebP',
    '转换这个附件',
    '把图片制作一下',
    '把图片保存为 ZIP',
    '把附件另存一份',
    '导出这个文档',
    'transcode this audio',
    'convert this file',
    'save this image as TIF',
    'export this document as DOCX',
    'make this image a ZIP',
    'turn it into TIF',
    'change this file to DOCX',
    '用万象转换处理这个附件',
    '处理这个附件',
    '不要解释，直接转换这个附件',
    '不要说明安全性，把附件导出为 ZIP',
    '转换这个附件后，告诉我它是什么格式',
    'convert this file; what format is it afterward',
    '不要转换成 Word，而是 ZIP',
    "don't convert to Word; DOCX instead",
    'Can you convert this file to RAR?',
    'Could you convert this attachment?',
    'Would you save this image as 7z?',
    '你能把图片转成 CUR 吗？',
    '可以转换这个附件吗？',
    '请问能不能导出为 RAR？',
    "don't convert this image, save it as WebP",
    "don't convert this image then save it as CUR",
    "don't convert this image save it as WebP",
    '不要把图片转成 PNG，保存为 CUR',
    '不要把图片转成 PNG 然后另存为 rar',
    '不要转换这个附件随后保存为 CUR',
    "don't explain then convert this file",
    '不要 png，而是 rar',
    '不要 7z，而是 cur',
    'not png; rar instead',
    'not 7z, cur instead',
    '支持哪些格式并把这个附件转换成 PDF',
    '万象转换支持什么格式同时将图片保存为 WebP',
    'What formats are supported and convert this file to PDF',
    'Which formats can it convert to and save this image as WebP',
    'not PNG but JPG',
    'not 7z but rar',
    '不要解释直接转换这个附件',
    "Don't explain just convert this file to PDF",
    '描述图片并把它转成 PDF',
    '查看这个文件以及导出为 DOCX',
    'Explain which formats are supported and convert this file to PDF',
    "don't convert this file, but save it as PDF",
    '不要转换这个附件，但是导出为 PDF',
    'Convert the attachment from this conversation to PDF',
    '把这段对话中的当前图片转换为WebP',
    'convert the attached conversation.png to WebP',
    'convert the conversation and this attachment to PDF',
    'not .heif but .jxl',
    'not JPEG2000 but JPEGXL',
    'Please, not PNG but JPG',
    'not PNG but JPG, please',
    'Either explain which formats this tool can convert to or convert this file to PDF',
    'You can explain which formats it can convert to or save this image as WebP',
    'Explain which formats are supported, then convert this file to PDF',
    'Convert conversation.png to WebP',
    '转换聊天记录.png为WebP',
    'Can this tool convert PNG or JPG or I want you to convert this attachment to PDF',
    'Could it convert HEIC otherwise convert this file to WebP',
    'No matter what this tool can convert, convert this attachment to PDF',
    '不要 .heif，而是 .jxl',
    '不要 HEIF，而是 JXL',
    'Convert conversation-about-attachment.png to WebP',
    '转换对话-包含-附件.png为WebP',
    'convert chat-history-with-image.jpg to PNG',
    'Review this attachment in the conversation, then convert it to PDF',
    '查看当前图片所在的对话，然后把它转换为 WebP',
    'Can this tool convert PNG or JPG or I would like you to convert this attachment to PDF',
    'Could it convert HEIC or could you convert this file to WebP',
    'Can this tool convert PNG or JPG or would you convert this attachment to PDF',
    'Can this tool convert PNG or JPG just convert this attachment to PDF',
    'Could it convert HEIC please convert this file to WebP',
    'Convert this attachment and this conversation to PDF',
    'Convert this image or this conversation to PDF',
    'Convert this conversation or this image to PDF',
    '把这个附件和这段对话转换为PDF',
    '把这段对话和这个附件转换为PDF',
    'No matter what this tool can convert just convert this attachment to PDF',
    'No matter what it can convert please save this image as WebP',
    'How do I convert PNG then I want you to convert this file to PDF',
    'How can I save PNG or please convert this attachment to PDF',
    '如何把图片转换为 PNG 然后请把这个附件转换为 PDF',
    '怎么把图片保存为 PNG 然后直接把当前图片保存为 WebP',
  ])('recognizes a current-attachment conversion request: %s', (text) => {
    expect(hasLocalConversionIntent(text, attachments)).toBe(true)
  })

  it.each([
    ["don't make this image an ICO", ', but ', 'save it as WebP'],
    ["don't make this image an ICO", '; ', 'turn it into WebP'],
    ["don't make this image an ICO", '. ', 'make it a WebP instead'],
    ['不要把图片做成 ICO', '，但', '请将它保存为 WebP'],
    ['不要把文件转成 PDF', '；', '请把它另存为 JPG'],
    ['不要把照片制作成 ICNS', '，然后', '把它输出为 PNG'],
  ] as const)(
    'recognizes a positive second conversion clause: %s%s%s',
    (negativeClause, separator, positiveClause) => {
      expect(hasLocalConversionIntent(
        `${negativeClause}${separator}${positiveClause}`,
        attachments,
      )).toBe(true)
    },
  )

  it.each([
    ['', attachments],
    ['总结这份 PDF', attachments],
    ['附件是什么格式？', attachments],
    ['不要转换这个附件', attachments],
    ["don't convert this attachment", attachments],
    ['不要把这个附件转换成 PDF', attachments],
    ["don't convert this file to PDF", attachments],
    ['不要把图片做成 ICO', attachments],
    ['请勿把图片保存为 WebP', attachments],
    ['不要将图片保存成 .ico', attachments],
    ['不要将图片保存成 .ico，只需总结它', attachments],
    ["don't make this image an ICO", attachments],
    ['never save this image as WebP', attachments],
    ['帮我总结这张图片', attachments],
    ['这张图片是什么格式？', attachments],
    ['不要把图片做成 ICO，只需总结它', attachments],
    ['不要把图片做成 ICO，而是总结它', attachments],
    ['请勿保存为 WebP，我只是问它是什么格式', attachments],
    ["don't make this image an ICO; summarize it instead", attachments],
    ["don't make this image an ICO; don't save it as WebP", attachments],
    ['不要把图片做成 ICO，也不要将它保存为 WebP', attachments],
    ['What formats are supported?', attachments],
    ['Which formats can it convert to?', attachments],
    ['不用转换这个附件', attachments],
    ['不需要把图片保存为 ZIP', attachments],
    ['请不用万象转换处理这个附件', attachments],
    ['no need to convert this file', attachments],
    ['Please, no need to transcode this audio', attachments],
    ['no need to save this image as TIF', attachments],
    ['介绍一下万象转换', attachments],
    ['万象转换是什么？', attachments],
    ['万象转换支持哪些格式？', attachments],
    ['万象转换能转换哪些格式？', attachments],
    ['这个工具能把图片转成什么格式？', attachments],
    ['万象转换安全吗？', attachments],
    ['万象转换会上传文件吗？', attachments],
    ['如何使用万象转换？', attachments],
    ['不要非常快速地把这个附件转换成 ZIP', attachments],
    ["Please don't ever quickly convert this file to RAR", attachments],
    ['制作一张海报', attachments],
    ['save this conversation', attachments],
    ['export chat history', attachments],
    ['解释一下转换率', attachments],
    ['process the conversation', attachments],
    ["don't convert or save this file", attachments],
    ["don't convert and save this file", attachments],
    ['不要转换或导出这个附件', attachments],
    ['不要转换和导出这个附件', attachments],
    ['不要解释转换原理', attachments],
    ["don't explain how to convert this file", attachments],
    ['制作海报并查看附件', attachments],
    ['保存对话并描述图片', attachments],
    ['export chat history and analyze image', attachments],
    ['This image is not dark but vivid', attachments],
    ['This file is not PNG but JPG', attachments],
    ['The attachment is not safe but risky', attachments],
    ['save this conversation as PDF', attachments],
    ['export chat history as PDF', attachments],
    ['把对话保存为 PDF', attachments],
    ['把聊天记录导出为 PDF', attachments],
    ['convert this conversation to PDF', attachments],
    ['save chat history as PDF', attachments],
    ['把这段对话转为 PDF', attachments],
    ['将聊天记录导出为 PDF', attachments],
    ["don't convert this file, or save it as PDF", attachments],
    ['不要转换这个附件，或导出为 PDF', attachments],
    ['Can this tool convert PNG or JPG?', attachments],
    ['Could it convert PDF or DOCX?', attachments],
    ['save this conversation with comments as PDF', attachments],
    ['Explain how to convert and save this file', attachments],
    ['Explain how to convert or export this file', attachments],
    ['Just explain how to convert this file', attachments],
    ["Don't explain how to convert or save this file", attachments],
    ['说明如何转换并保存这个附件', attachments],
    ['介绍怎么转换和导出这个文件', attachments],
    ["don't convert this file, and save it as PDF", attachments],
    ["don't convert this file; and export it as PDF", attachments],
    ['不要转换这个附件，和保存为 PDF', attachments],
    ['不要转换这个附件；并导出为 PDF', attachments],
    ['Explain just how to convert this file', attachments],
    ['Explain how to convert and how to save this file', attachments],
    ['说明直接如何转换这个附件', attachments],
    ['介绍如何转换以及如何导出这个文件', attachments],
    ['Convert this conversation and save it as PDF', attachments],
    ['Review this chat history, then export it as PDF', attachments],
    ['查看这段对话，然后把它导出为 PDF', attachments],
    ['总结聊天记录；将它保存为 PDF', attachments],
    ['Convert this conversation about the attachment to PDF', attachments],
    ['Save the conversation with this image as PDF', attachments],
    ['把关于当前图片的对话转换为 PDF', attachments],
    ['将包含这个附件的聊天记录导出为 PDF', attachments],
    ['不要黑暗，而是鲜艳', attachments],
    ['不要苹果，而是香蕉', attachments],
    ['Convert this conversation to transcript.pdf', attachments],
    ['Save this conversation as archive.pdf', attachments],
    ['Convert this conversation from attachment.txt to PDF', attachments],
    ['把这段对话转换为 transcript.pdf', attachments],
    ['把来自附件.txt的聊天记录导出为 PDF', attachments],
    ['将关于图片的对话保存为 archive.pdf', attachments],
    ['How do I convert this file to PDF?', attachments],
    ['How can I save this image as WebP?', attachments],
    ['Can this tool convert PNG or convert JPG?', attachments],
    ['Can this tool convert a PNG file or convert a JPG file?', attachments],
    ['Could this converter save images as PNG or export documents as PDF?', attachments],
    ['如何把这个文件转换为PDF？', attachments],
    ['怎么把这个图片保存为WebP？', attachments],
    ['把附件转换成 PDF', []],
  ] as const)('does not redact ordinary or attachment-free turns: %s', (text, currentAttachments) => {
    expect(hasLocalConversionIntent(text, currentAttachments)).toBe(false)
  })

  it.each([
    'not foo but bar',
    'This image is not .dark but .vivid',
  ])('keeps ambiguous unsupported bare shorthand non-local: %s', (text) => {
    expect(hasLocalConversionIntent(text, attachments)).toBe(false)
  })

  it.each([
    ['千万不要', '把图片做成', 'ICO格式'],
    ['请千万不要', '将文件保存为', 'JPG'],
    ['请勿', '把它转成', '.webp'],
    ['Please don’t', 'make this image an', 'ICO'],
    ["Please don't", 'save the file as', 'JPG'],
    ['Never', 'turn it into', '.WebP'],
    ['不用', '转换', 'ZIP'],
    ['不需要', '把附件保存为', 'TIF'],
    ['no need to', 'export this file as', 'DOCX'],
    ['千万不要', '非常快速地把附件转换成', 'RAR'],
    ["Please don't", 'ever very quickly convert this file to', '7z'],
  ] as const)('keeps a negated conversion non-local: %s %s %s', (modifier, action, target) => {
    expect(hasLocalConversionIntent(`${modifier} ${action} ${target}`, attachments)).toBe(false)
  })

  it.each([
    ['支持转换成', '哪些格式？'],
    ['可以把图片转换成', '什么格式？'],
    ['请问能将这个文件转成', '哪些格式？'],
    ['万象转换支持', '什么格式？'],
    ['万象转换能转换', '哪些格式？'],
    ['这个工具能把图片转成', '什么格式？'],
  ] as const)('keeps a capability question non-local: %s%s', (prefix, targetQuestion) => {
    expect(hasLocalConversionIntent(`${prefix}${targetQuestion}`, attachments)).toBe(false)
  })

  it('projects only anonymous current metadata with stable zero-based indexes', () => {
    const prompt = projectLocalConversionPrompt('把附件转为 PDF', [
      { index: 0, name: '../../data:secret\nreport.pdf', mimeType: 'application/pdf', byteSize: 12 },
      { index: 1, name: 'C:\\private\\CON ', mimeType: 'application/octet-stream', byteSize: 34 },
    ])

    expect(prompt).toBe([
      '把附件转为 PDF',
      '[附件 0: 文件-1, application/pdf, 12 bytes]',
      '[附件 1: 文件-2, application/octet-stream, 34 bytes]',
    ].join('\n'))
    expect(prompt).not.toMatch(/data:|secret|private|\\|\.\./i)
  })

  it('anonymizes an exact attachment name repeated in user text', () => {
    const prompt = projectLocalConversionPrompt('请把 tax-return-secret.pdf 转成 PDF', [{
      index: 0, name: 'tax-return-secret.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])

    expect(prompt).toContain('请把 文件-1 转成 PDF')
    expect(prompt).not.toContain('tax-return-secret.pdf')
  })

  it('anonymizes every NFKC and case-equivalent attachment basename mention', () => {
    const prompt = projectLocalConversionPrompt(
      '转换 secret-file.pdf、SECRET-FILE.PDF 和 Secret-Ｆile.PDF',
      [{ index: 0, name: 'Secret-Ｆile.PDF', mimeType: 'application/pdf', byteSize: 12 }],
    )

    expect(prompt).toContain('转换 文件-1、文件-1 和 文件-1')
    expect(prompt.normalize('NFKC').toLocaleLowerCase('und')).not.toContain('secret-file.pdf')
  })

  it.each([
    ['Straße.pdf', 'STRASSE.PDF straße.pdf ẞTRASSE.PDF'],
    ['İnvoice.pdf', 'invoice.pdf İNVOICE.PDF i\u0307nvoice.pdf'],
    ['ΟΣ.pdf', 'οσ.pdf ος.pdf ΟΣ.PDF'],
    ['oﬃce.pdf', 'OFFICE.PDF oﬃce.pdf office.pdf'],
  ])('anonymizes full NFKC-casefold equivalent names for %s', (name, mentions) => {
    const prompt = projectLocalConversionPrompt(
      `转换 ${mentions}`,
      [{ index: 0, name, mimeType: 'application/pdf', byteSize: 12 }],
    )

    expect(prompt.match(/文件-1/gu)).toHaveLength(4)
    expect(prompt).not.toMatch(/strasse|straße|invoice|i\u0307nvoice|οσ|ος|office|oﬃce/iu)
  })

  it.each([
    ['Straße.pdf', '/Users/alice/Tax/STRASSE.PDF'],
    ['Straße.pdf', String.raw`C:\Users\Alice\Tax\STRASSE.PDF`],
    ['Straße.pdf', String.raw`\\server\private\Folder\Straße.pdf`],
    ['Folder\\Straße.pdf', 'private/Folder/STRASSE.PDF'],
    ['Folder/Straße.pdf', String.raw`private\Folder\STRASSE.PDF`],
  ])('anonymizes the complete path-like token containing a folded basename: %s in %s', (name, mention) => {
    const prompt = projectLocalConversionPrompt(
      `转换 ${mention} 和 ${mention}`,
      [{ index: 0, name, mimeType: 'application/pdf', byteSize: 12 }],
    )

    expect(prompt).toContain('转换 文件-1 和 文件-1')
    expect(prompt).not.toMatch(/users|alice|tax|server|private|folder|strasse|straße/iu)
  })

  it.each([
    ['Straße.pdf', '/Users/Alice/Tax Returns/STRASSE.PDF'],
    ['Straße.pdf', String.raw`C:\Users\Alice\Private Files\Straße.pdf`],
    ['Straße.pdf', String.raw`\\server\Private Share\Folder\STRASSE.PDF`],
    ['Straße.pdf', 'relative/Private Folder/STRASSE.PDF'],
    ['Straße.pdf', 'relative\\Private/Folder Name\\Straße.pdf'],
    ['Straße.pdf', 'relative/Private\u00a0Folder/STRASSE.PDF'],
    ['Straße.pdf', 'relative/Private\u3000Folder/STRASSE.PDF'],
  ])('anonymizes an unquoted path token containing directory spaces: %s in %s', (name, mention) => {
    const prompt = projectLocalConversionPrompt(
      `转换 ${mention} 和 ${mention}`,
      [{ index: 0, name, mimeType: 'application/pdf', byteSize: 12 }],
    )

    expect(prompt).toContain('转换 文件-1 和 文件-1')
    expect(prompt).not.toMatch(/users|alice|tax|returns|server|private|share|folder|relative|strasse|straße/iu)
  })

  it.each([
    ['Straße.pdf', '"/Users/Alice/Tax Returns/STRASSE.PDF"'],
    ['Straße.pdf', String.raw`'C:\Private Files\Straße.pdf'`],
    ['Straße.pdf', '“relative/Private Folder/STRASSE.PDF”'],
  ])('anonymizes the path inside quotes without retaining directory segments: %s in %s', (name, mention) => {
    const prompt = projectLocalConversionPrompt(
      `转换 ${mention}`,
      [{ index: 0, name, mimeType: 'application/pdf', byteSize: 12 }],
    )

    expect(prompt).toMatch(/转换 ["'“]文件-1["'”]/u)
    expect(prompt).not.toMatch(/users|alice|tax|returns|private|folder|relative|strasse|straße/iu)
  })

  it.each([
    ['/Users/Alice/Export Data/SECRET.PDF', 'Convert /Users/Alice/Export Data/SECRET.PDF to PDF'],
    ['/Volumes/Read Only/SECRET.PDF', 'Open /Volumes/Read Only/SECRET.PDF'],
    ['/srv/Research and Legal/SECRET.PDF', 'Convert /srv/Research and Legal/SECRET.PDF to PDF'],
    [String.raw`C:\Windows Open Files\SECRET.PDF`, String.raw`Convert C:\Windows Open Files\SECRET.PDF to PDF`],
    [String.raw`\\server\UNC Save As\SECRET.PDF`, String.raw`Convert \\server\UNC Save As\SECRET.PDF to PDF`],
    ['资料/中文 转换 资料/SECRET.PDF', '转换 资料/中文 转换 资料/SECRET.PDF 为 PDF'],
    ['"/Users/Alice/Tax\u00a0Returns/SECRET.PDF"', 'Convert "/Users/Alice/Tax\u00a0Returns/SECRET.PDF" to PDF'],
    ['"/Users/Alice/Tax, Returns/SECRET.PDF"', 'Convert "/Users/Alice/Tax, Returns/SECRET.PDF" to PDF'],
  ])('treats action, conjunction, punctuation, and Unicode spaces inside %s as path data', (mention, request) => {
    const prompt = projectLocalConversionPrompt(request, [{
      index: 0, name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])

    expect(prompt).toContain(request.replace(mention, mention.startsWith('"') ? '"文件-1"' : '文件-1'))
    expect(prompt).not.toMatch(/users|alice|export data|read only|research|legal|windows open|unc save|中文|资料|tax|returns|secret\.pdf/iu)
  })

  it('indexes path boundaries once and scales with many repeated path occurrences', () => {
    const occurrence = '/Users/Alice/Research and Legal/SECRET.PDF'
    const prompt = anonymizeAttachmentNames(
      Array.from({ length: 512 }, () => occurrence).join(' '),
      [{ index: 0, name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 12 }],
    )

    expect(prompt.match(/文件-1/gu)).toHaveLength(512)
    expect(prompt).not.toMatch(/users|alice|research|legal|secret\.pdf/iu)
    expect(anonymizeAttachmentNames.toString()).not.toMatch(/prefix\.matchAll|replacements\.some/u)
  })

  it.each([
    ["/Users/O'Neil/SECRET.PDF", "Convert /Users/O'Neil/SECRET.PDF to PDF"],
    ['/Users/O’Neil/SECRET.PDF', 'Convert /Users/O’Neil/SECRET.PDF to PDF'],
    ['/Users/Alice/"Draft"/SECRET.PDF', 'Convert /Users/Alice/"Draft"/SECRET.PDF to PDF'],
    ["C:\\O'Neil\\Draft' Files\\SECRET.PDF", "Convert C:\\O'Neil\\Draft' Files\\SECRET.PDF to PDF"],
    ['\\\\server\\O’Neil\\“Draft\\SECRET.PDF', 'Convert \\\\server\\O’Neil\\“Draft\\SECRET.PDF to PDF'],
    ["relative/O'Neil/SECRET.PDF", "Convert relative/O'Neil/SECRET.PDF to PDF"],
    ["relative\\O’Neil/O'Neil\\SECRET.PDF", "Convert relative\\O’Neil/O'Neil\\SECRET.PDF to PDF"],
  ])('keeps paired and unpaired apostrophes or quotes inside the complete path span: %s', (mention, request) => {
    const prompt = projectLocalConversionPrompt(request, [{
      index: 0, name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])

    expect(prompt).toContain(request.replace(mention, '文件-1'))
    expect(prompt).not.toMatch(/users|o['’]neil|draft|server|relative|secret\.pdf/iu)
  })

  it.each([
    ["O'Neil.pdf", "/Users/Alice/O'NEIL.PDF"],
    ['O’Neil.pdf', 'C:\\Users\\Alice\\O’NEIL.PDF'],
    ['Draft".pdf', '\\\\server\\Private\\DRAFT".PDF'],
  ])('anonymizes a complete path when the attachment filename itself contains a quote: %s', (name, mention) => {
    expect(projectLocalConversionPrompt(`Convert ${mention} to PDF`, [{
      index: 0, name, mimeType: 'application/pdf', byteSize: 12,
    }])).toContain('Convert 文件-1 to PDF')
  })

  it.each([
    ['see yes/no first, then convert SECRET.PDF', 'see yes/no first, then convert 文件-1'],
    ['read https://example.test/a/b first, then convert SECRET.PDF', 'read https://example.test/a/b first, then convert 文件-1'],
    ['email a/b@example.com before converting SECRET.PDF', 'email a/b@example.com before converting 文件-1'],
    ['ordinary/path note. Convert SECRET.PDF', 'ordinary/path note. Convert 文件-1'],
  ])('does not extend an earlier slash across ordinary prose to %s', (request, expected) => {
    expect(projectLocalConversionPrompt(request, [{
      index: 0, name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])).toContain(expected)
  })

  it.each([
    ['Convert (/Users/Alice/Tax Returns/SECRET.PDF) to PDF', 'Convert (文件-1) to PDF'],
    [String.raw`Convert [C:\Private Files\SECRET.PDF] to PDF`, 'Convert [文件-1] to PDF'],
  ])('preserves paired brackets around a fully anonymized path token: %s', (request, expected) => {
    expect(projectLocalConversionPrompt(request, [{
      index: 0, name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])).toContain(expected)
  })

  it.each([
    ["O'Neil/Private/SECRET.PDF", "O'Neil/Private/SECRET.PDF"],
    ['O’Neil/Private/SECRET.PDF', 'O’Neil/Private/SECRET.PDF'],
    ['Private Folder/Legal/SECRET.PDF', 'Private Folder/Legal/SECRET.PDF'],
    ['Private\u00a0Folder/Legal/SECRET.PDF', 'Private\u00a0Folder/Legal/SECRET.PDF'],
    ['中文 空格/资料/SECRET.PDF', '中文 空格/资料/SECRET.PDF'],
    ['“Draft” Folder/Legal/SECRET.PDF', '“Draft” Folder/Legal/SECRET.PDF'],
    ['"O\'Neil/Private/SECRET.PDF"', '"O\'Neil/Private/SECRET.PDF"'],
  ])('anonymizes a relative path whose first segment contains spaces or quotes: %s', (mention, request) => {
    const prompt = anonymizeAttachmentNames(request, [{
      index: 0, name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])
    expect(prompt).toBe(mention.startsWith('"') ? '"文件-1"' : '文件-1')
  })

  it.each([
    ['see yes/no first, then convert /Users/Alice/SECRET.PDF', 'see yes/no first, then convert 文件-1'],
    ['read https://example.test/a/b then convert /Users/Alice/SECRET.PDF', 'read https://example.test/a/b then convert 文件-1'],
    ['email a/b@example.com then convert /Users/Alice/SECRET.PDF', 'email a/b@example.com then convert 文件-1'],
    ['ordinary/path note. Convert /Users/Alice/SECRET.PDF', 'ordinary/path note. Convert 文件-1'],
    ["don't convert yes/no; use /Users/Alice/SECRET.PDF", "don't convert yes/no; use 文件-1"],
  ])('terminates an earlier slash token before anonymizing a later absolute path: %s', (request, expected) => {
    expect(anonymizeAttachmentNames(request, [{
      index: 0, name: 'secret.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])).toBe(expected)
  })

  it('keeps ordinary slash-separated prose that does not end in an attachment basename', () => {
    expect(projectLocalConversionPrompt('说明 yes/no 选项', [{
      index: 0, name: 'report.pdf', mimeType: 'application/pdf', byteSize: 12,
    }])).toContain('说明 yes/no 选项')
  })

  it('keeps a long non-conversion attachment request non-local', () => {
    const text = `总结这段对话 ${'ordinary context '.repeat(2_000)} 并描述附件`
    expect(hasLocalConversionIntent(text, attachments)).toBe(false)
  })

  it.each([
    ['https://private.example/report.pdf', 0, '文件-1'],
    ['..\\..\\invoice.pdf. ', 1, 'invoice.pdf'],
    ['normal name.docx', 2, 'normal name.docx'],
    ['report\u202Egpj\u2066.pdf', 3, 'reportgpj.pdf'],
    ['invoice：目标格式：png.pdf', 4, '文件-5'],
    ['safe\u0000\n附件 9：other.pdf', 5, '文件-6'],
    ['附\u034F件-secret.pdf', 6, '文件-7'],
    ['目\uFE0F标格\u0301式-report.pdf', 7, '文件-8'],
    ['附\u02D0件-\uA789-\u2236.pdf', 8, '文件-9'],
    ['目\u02D0标格式-\uA789-\u2236.pdf', 9, '文件-10'],
    ['voice\u02D0note.pdf', 10, 'voicenote.pdf'],
    ['report\uA789private\u2236data.pdf', 11, 'report-private-data.pdf'],
  ] as const)('sanitizes display name %s without exposing path-like prefixes', (name, index, expected) => {
    expect(sanitizeDisplayName(name, index)).toBe(expected)
  })
})
