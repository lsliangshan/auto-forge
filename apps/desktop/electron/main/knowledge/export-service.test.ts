import { describe, expect, it } from 'vitest'
import { KnowledgeExportService } from './export-service.js'
import { memoryKnowledgeStore } from './knowledge-test-support.js'

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function parseStoredZip(archive: Buffer): Map<string, Buffer> {
  const endOffset = archive.length - 22
  expect(archive.readUInt32LE(endOffset)).toBe(0x06054b50)
  const entryCount = archive.readUInt16LE(endOffset + 10)
  let centralOffset = archive.readUInt32LE(endOffset + 16)
  const entries = new Map<string, Buffer>()
  for (let index = 0; index < entryCount; index += 1) {
    expect(archive.readUInt32LE(centralOffset)).toBe(0x02014b50)
    const checksum = archive.readUInt32LE(centralOffset + 16)
    const size = archive.readUInt32LE(centralOffset + 24)
    const nameLength = archive.readUInt16LE(centralOffset + 28)
    const extraLength = archive.readUInt16LE(centralOffset + 30)
    const commentLength = archive.readUInt16LE(centralOffset + 32)
    const localOffset = archive.readUInt32LE(centralOffset + 42)
    const name = archive.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8')
    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const contents = Buffer.from(archive.subarray(start, start + size))
    expect(crc32(contents)).toBe(checksum)
    entries.set(name, contents)
    centralOffset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('knowledge export service', () => {
  it('writes originals and a sanitized manifest without private implementation data', async () => {
    // Catches exports that leak paths, vectors, keys, chunks, queries, or URLs.
    const memory = memoryKnowledgeStore()
    const original = Buffer.from('原始合同正文')
    const stored = await memory.objects.put(original)
    const db = memory.database
    db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('base', '合同库', 1, 2)
    db.prepare(`INSERT INTO documents(
      id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
      lifecycle_status, publication_generation, recycled_at
    ) VALUES ('doc', 'base', '合同.txt', 'text/plain', NULL, 1, 2, 'ready', 1, NULL)`).run()
    db.prepare(`INSERT INTO document_versions(
      id, document_id, version_number, status, content_hash, object_id, created_at,
      publication_generation, name, mime_type
    ) VALUES ('version', 'doc', 1, 'ready', 'secret-hash', ?, 2, 1, '合同.txt', 'text/plain')`).run(stored.objectId)
    db.prepare("UPDATE documents SET active_version_id = 'version' WHERE id = 'doc'").run()
    db.prepare(`INSERT INTO knowledge_blocks(id, version_id, ordinal, kind, text, coordinates_json)
      VALUES ('block', 'version', 0, 'txt', 'hidden chunk sentinel', '{"kind":"txt"}')`).run()
    db.prepare(`INSERT INTO kb_chunks(id, knowledge_base_id, document_id, version_id, block_id, ordinal, body, coordinates_json)
      VALUES ('chunk', 'base', 'doc', 'version', 'block', 0, 'query url https://secret.example', '{"kind":"txt"}')`).run()
    let archive: Buffer | undefined
    const exporter = new KnowledgeExportService({
      database: db,
      objects: memory.objects,
      save: async (_name, bytes) => { archive = Buffer.from(bytes) },
    })

    await exporter.exportBase('base')

    expect(archive).toBeDefined()
    const entries = parseStoredZip(archive!)
    expect(entries.get('originals/version.txt')).toEqual(original)
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      documents: Array<{ versions: Array<{ name: string; mimeType: string }> }>
    }
    expect(manifest.documents[0]?.versions).toEqual([
      expect.objectContaining({ name: '合同.txt', mimeType: 'text/plain' }),
    ])
    const serialized = archive!.toString('utf8')
    expect(serialized).not.toMatch(/secret-hash|hidden chunk sentinel|query url|https:\/\/|objectId|vector|localPath|filePath|key/i)
  })

  it('exports each immutable version with its own staged name, MIME type, and extension', async () => {
    const memory = memoryKnowledgeStore()
    const oldObject = await memory.objects.put(Buffer.from('old text'))
    const newObject = await memory.objects.put(Buffer.from('%PDF-new'))
    const db = memory.database
    db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('base', '合同库', 1, 3)
    db.prepare(`INSERT INTO documents(
      id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
      lifecycle_status, publication_generation, recycled_at
    ) VALUES ('doc', 'base', '新版.pdf', 'application/pdf', NULL, 1, 3, 'ready', 2, NULL)`).run()
    db.prepare(`INSERT INTO document_versions(
      id, document_id, version_number, status, content_hash, object_id, created_at,
      publication_generation, name, mime_type
    ) VALUES
      ('v1', 'doc', 1, 'superseded', 'h1', ?, 1, 1, '旧版.txt', 'text/plain'),
      ('v2', 'doc', 2, 'ready', 'h2', ?, 2, 2, '新版.pdf', 'application/pdf')
    `).run(oldObject.objectId, newObject.objectId)
    let archive: Buffer | undefined
    await new KnowledgeExportService({
      database: db,
      objects: memory.objects,
      save: async (_name, contents) => { archive = Buffer.from(contents) },
    }).exportBase('base')

    const entries = parseStoredZip(archive!)
    expect(entries.get('originals/v1.txt')?.toString()).toBe('old text')
    expect(entries.get('originals/v2.pdf')?.toString()).toBe('%PDF-new')
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      documents: Array<{ versions: Array<{ id: string; name: string; mimeType: string }> }>
    }
    expect(manifest.documents[0]?.versions).toEqual([
      expect.objectContaining({ id: 'v1', name: '旧版.txt', mimeType: 'text/plain' }),
      expect.objectContaining({ id: 'v2', name: '新版.pdf', mimeType: 'application/pdf' }),
    ])
  })

  it('clears the assembled archive when the user-visible save fails', async () => {
    // Catches plaintext export buffers retained after a failed filesystem write.
    const memory = memoryKnowledgeStore()
    memory.database.prepare(
      'INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('base', '合同库', 1, 2)
    let captured: Buffer | undefined
    const exporter = new KnowledgeExportService({
      database: memory.database,
      objects: memory.objects,
      save: async (_name, bytes) => {
        captured = bytes
        throw new Error('save failed')
      },
    })

    await expect(exporter.exportBase('base')).rejects.toThrow('save failed')
    expect(captured).toBeDefined()
    expect(captured!.every(byte => byte === 0)).toBe(true)
  })

  it('rejects an export before retained originals exceed its memory ceiling', async () => {
    // Catches repeated immutable versions growing one in-memory ZIP without a hard bound.
    const memory = memoryKnowledgeStore()
    const first = await memory.objects.put(Buffer.from('1234'))
    const second = await memory.objects.put(Buffer.from('5678'))
    const db = memory.database
    db.prepare('INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('base', '合同库', 1, 2)
    db.prepare(`INSERT INTO documents(
      id, knowledge_base_id, name, mime_type, active_version_id, created_at, updated_at,
      lifecycle_status, publication_generation, recycled_at
    ) VALUES ('doc', 'base', '合同.txt', 'text/plain', NULL, 1, 2, 'ready', 2, NULL)`).run()
    db.prepare(`INSERT INTO document_versions(
      id, document_id, version_number, status, content_hash, object_id, created_at, publication_generation
    ) VALUES ('v1', 'doc', 1, 'superseded', 'h1', ?, 1, 1),
             ('v2', 'doc', 2, 'ready', 'h2', ?, 2, 2)`).run(first.objectId, second.objectId)
    const exporter = new KnowledgeExportService({
      database: db,
      objects: memory.objects,
      save: async () => undefined,
      maxBytes: 5,
    })

    await expect(exporter.exportBase('base')).rejects.toThrow('export exceeds its limit')
  })
})
