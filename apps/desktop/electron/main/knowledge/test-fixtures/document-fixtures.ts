import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function u16(value: number): Buffer {
  const output = Buffer.alloc(2)
  output.writeUInt16LE(value)
  return output
}

function u32(value: number): Buffer {
  const output = Buffer.alloc(4)
  output.writeUInt32LE(value >>> 0)
  return output
}

export function storedZip(entries: ReadonlyArray<{ name: string; contents: string }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const contents = Buffer.from(entry.contents, 'utf8')
    const checksum = crc32(contents)
    const local = Buffer.concat([
      Buffer.from('504b0304', 'hex'),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(contents.length), u32(contents.length),
      u16(name.length), u16(0), name, contents,
    ])
    localParts.push(local)
    centralParts.push(Buffer.concat([
      Buffer.from('504b0102', 'hex'),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(contents.length), u32(contents.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset), name,
    ]))
    localOffset += local.length
  }
  const central = Buffer.concat(centralParts)
  return Buffer.concat([
    ...localParts,
    central,
    Buffer.from('504b0506', 'hex'),
    u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(localOffset), u16(0),
  ])
}

export function minimalDocx(extraCharacters = 0): Buffer {
  return storedZip([
    {
      name: '[Content_Types].xml',
      contents: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      contents: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      contents: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DOCX heading</w:t></w:r></w:p><w:p><w:r><w:t>DOCX paragraph${'x'.repeat(extraCharacters)}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    },
  ])
}

export function minimalPdf(pageTexts: ReadonlyArray<string | undefined>): Buffer {
  const pageObjectNumbers = pageTexts.map((_, index) => 3 + index)
  const fontObjectNumber = 3 + pageTexts.length
  const firstStreamObjectNumber = fontObjectNumber + 1
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectNumbers.map(number => `${number} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  ]
  pageTexts.forEach((_, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> /Contents ${firstStreamObjectNumber + index} 0 R >>`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  pageTexts.forEach((text) => {
    const stream = text === undefined ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}

export function compressedPdf(text: string): Buffer {
  const compressed = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'ascii'))
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([
      Buffer.from(`<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`),
      compressed,
      Buffer.from('\nendstream'),
    ]),
  ]
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  let length = parts[0]!.length
  objects.forEach((object, index) => {
    offsets.push(length)
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    parts.push(entry)
    length += entry.length
  })
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(parts)
}

const PDF_PASSWORD_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

function rc4(key: Uint8Array, input: Uint8Array): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index]! + key[index % key.length]!) & 0xff
    ;[state[index], state[j]] = [state[j]!, state[index]!]
  }
  const output = Buffer.alloc(input.length)
  let i = 0
  j = 0
  for (let index = 0; index < input.length; index += 1) {
    i = (i + 1) & 0xff
    j = (j + state[i]!) & 0xff
    ;[state[i], state[j]] = [state[j]!, state[i]!]
    output[index] = input[index]! ^ state[(state[i]! + state[j]!) & 0xff]!
  }
  return output
}

export function encryptedPdf(password = 'test'): Buffer {
  const pad = (value: string) => Buffer.concat([Buffer.from(value, 'ascii'), PDF_PASSWORD_PADDING]).subarray(0, 32)
  const digest = (...parts: Uint8Array[]) => createHash('md5').update(Buffer.concat(parts)).digest()
  const userPassword = pad(password)
  const ownerEntry = rc4(digest(pad('owner')).subarray(0, 5), userPassword)
  const permissions = Buffer.alloc(4)
  permissions.writeInt32LE(-4)
  const fileId = digest(Buffer.from('autoforge-parser-encrypted-fixture', 'ascii'))
  const encryptionKey = digest(userPassword, ownerEntry, permissions, fileId).subarray(0, 5)
  const userEntry = rc4(encryptionKey, PDF_PASSWORD_PADDING)
  const streamKey = digest(encryptionKey, Buffer.from([5, 0, 0, 0, 0])).subarray(0, 10)
  const encryptedStream = rc4(streamKey, Buffer.from('BT /F1 12 Tf 20 20 Td (Encrypted PDF) Tj ET', 'ascii'))
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 50] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>'),
    Buffer.concat([Buffer.from(`<< /Length ${encryptedStream.length} >>\nstream\n`), encryptedStream, Buffer.from('\nendstream')]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${ownerEntry.toString('hex')}> /U <${userEntry.toString('hex')}> /P -4 >>`),
  ]
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let length = parts[0]!.length
  objects.forEach((object, index) => {
    offsets.push(length)
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')])
    parts.push(entry)
    length += entry.length
  })
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>] >>\nstartxref\n${length}\n%%EOF\n`))
  return Buffer.concat(parts)
}
