import { execFile } from 'node:child_process'
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zipFixture(entries: Array<{ name: string, body: string }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const body = Buffer.from(entry.body, 'utf8')
    const checksum = crc32(body)
    const local = Buffer.alloc(30 + name.byteLength)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.byteLength, 18)
    local.writeUInt32LE(body.byteLength, 22)
    local.writeUInt16LE(name.byteLength, 26)
    name.copy(local, 30)
    const central = Buffer.alloc(46 + name.byteLength)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.byteLength, 20)
    central.writeUInt32LE(body.byteLength, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    locals.push(local, body)
    centrals.push(central)
    localOffset += local.byteLength + body.byteLength
  }
  const centralSize = centrals.reduce((total, entry) => total + entry.byteLength, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function docxFixture(text: string): Buffer {
  return zipFixture([
    {
      name: '[Content_Types].xml',
      body: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      body: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/document.xml',
      body: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ])
}

function pdfFixture(text: string): Buffer {
  const stream = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'ascii')
  const objects = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'ascii'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'ascii'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n', 'ascii'),
    Buffer.from('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n', 'ascii'),
    Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Length ${stream.byteLength} >>\nstream\n`, 'ascii'),
      stream,
      Buffer.from('\nendstream\nendobj\n', 'ascii'),
    ]),
  ]
  const header = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')
  const offsets: number[] = []
  let cursor = header.byteLength
  for (const object of objects) {
    offsets.push(cursor)
    cursor += object.byteLength
  }
  const xref = Buffer.from([
    'xref', '0 6', '0000000000 65535 f ',
    ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer', '<< /Size 6 /Root 1 0 R >>', 'startxref', String(cursor), '%%EOF', '',
  ].join('\n'), 'ascii')
  return Buffer.concat([header, ...objects, xref])
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd, env: { ...process.env, CI: '1' }, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${stderr || stdout || error.message}`))
        return
      }
      resolve()
    })
  })
}

describe('CloudBase knowledge deploy package', () => {
  it.runIf(process.platform === 'darwin')(
    'frozen-installs offline and runs its entry plus real TXT, DOCX, and PDF children',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-deploy-'))
      const deployRoot = join(directory, 'knowledge')
      const sourceRoot = fileURLToPath(new URL('../../cloudbase/knowledge/', import.meta.url))
      try {
        await cp(sourceRoot, deployRoot, {
          recursive: true,
          filter: source => basename(source) !== 'node_modules',
        })
        await run('pnpm', [
          'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--no-optional',
        ], deployRoot)
        const pdfManifest = join(deployRoot, 'node_modules', 'pdfjs-dist', 'package.json')
        expect(await realpath(pdfManifest)).toContain(deployRoot)
        expect(await realpath(join(
          deployRoot, 'node_modules', 'mammoth', 'package.json',
        ))).toContain(deployRoot)

        const deployedRequire = createRequire(join(deployRoot, 'package.json'))
        expect(deployedRequire('./index.js')).toEqual({ main: expect.any(Function) })
        const directParser = (deployedRequire('./worker/knowledge-worker.js') as {
          createKnowledgeParser: () => {
            parse: (input: { bytes: Buffer, mimeType: string, versionId: string }) => Promise<unknown>
          }
        }).createKnowledgeParser()
        await expect(directParser.parse({
          bytes: pdfFixture('Direct PDF'), mimeType: 'application/pdf', versionId: 'direct_pdf',
        })).resolves.toBeDefined()
        const { createKnowledgeParserProcess } = deployedRequire('./worker/parser-process.js') as {
          createKnowledgeParserProcess: () => {
            parse: (input: { bytes: Buffer, mimeType: string, versionId: string }) => Promise<{
              blocks: Array<{ body: string }>
            }>
          }
        }
        const parser = createKnowledgeParserProcess()
        const fixtures = [
          { bytes: Buffer.from('Real TXT'), mimeType: 'text/plain', expected: 'Real TXT' },
          {
            bytes: docxFixture('Real DOCX'),
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            expected: 'Real DOCX',
          },
          { bytes: pdfFixture('Real PDF'), mimeType: 'application/pdf', expected: 'Real PDF' },
        ]
        for (const [index, fixture] of fixtures.entries()) {
          let result: { blocks: Array<{ body: string }> }
          try {
            result = await parser.parse({
              bytes: fixture.bytes, mimeType: fixture.mimeType, versionId: `version_${index}`,
            })
          } catch (error) {
            throw new Error(`Failed deployed ${fixture.expected} parser smoke`, { cause: error })
          }
          expect(result.blocks.map(block => block.body).join('\n')).toContain(fixture.expected)
          expect(fixture.bytes.every(byte => byte === 0)).toBe(true)
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
