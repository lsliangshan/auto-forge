import type Database from 'better-sqlite3'

interface ObjectReader {
  read(objectId: string): Promise<Buffer>
}

interface ExportServiceDependencies {
  database: Database.Database
  objects: ObjectReader
  save(name: string, contents: Buffer): Promise<void>
  maxBytes?: number
}

interface ZipEntry {
  name: string
  contents: Buffer
}

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

function storedZip(entries: readonly ZipEntry[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.contents)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(entry.contents.length, 18)
    header.writeUInt32LE(entry.contents.length, 22)
    header.writeUInt16LE(name.length, 26)
    local.push(header, name, entry.contents)

    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(0x0800, 8)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(entry.contents.length, 20)
    directory.writeUInt32LE(entry.contents.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    offset += header.length + name.length + entry.contents.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

function extensionFor(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (mimeType === 'text/markdown') return 'md'
  if (mimeType === 'text/html') return 'html'
  return 'txt'
}

export class KnowledgeExportService {
  constructor(private readonly dependencies: ExportServiceDependencies) {}

  async exportBase(baseId: string): Promise<void> {
    const base = this.dependencies.database.prepare(`
      SELECT id, name, lifecycle_status, created_at, updated_at
      FROM knowledge_bases WHERE id = ?
    `).get(baseId) as {
      id: string; name: string; lifecycle_status: string; created_at: number; updated_at: number
    } | undefined
    if (!base) throw new Error('Knowledge base was not found')
    const documents = this.dependencies.database.prepare(`
      SELECT id, name, mime_type, lifecycle_status, created_at, updated_at
      FROM documents WHERE knowledge_base_id = ? ORDER BY created_at, id
    `).all(baseId) as Array<{
      id: string; name: string; mime_type: string; lifecycle_status: string; created_at: number; updated_at: number
    }>
    const entries: ZipEntry[] = []
    let archive: Buffer | undefined
    let retainedBytes = 0
    const maxBytes = this.dependencies.maxBytes ?? 128 * 1024 * 1024
    try {
      const manifestDocuments = []
      for (const document of documents) {
        const versions = this.dependencies.database.prepare(`
          SELECT id, version_number, status, object_id, created_at, name, mime_type
          FROM document_versions WHERE document_id = ? ORDER BY version_number
        `).all(document.id) as Array<{
          id: string; version_number: number; status: string; object_id: string; created_at: number
          name: string; mime_type: string
        }>
        for (const version of versions) {
          const contents = await this.dependencies.objects.read(version.object_id)
          retainedBytes += contents.length
          entries.push({
            name: `originals/${version.id}.${extensionFor(version.mime_type)}`,
            contents,
          })
          if (retainedBytes > maxBytes) throw new Error('Knowledge export exceeds its limit')
        }
        manifestDocuments.push({
          id: document.id,
          name: document.name,
          mimeType: document.mime_type,
          status: document.lifecycle_status,
          createdAt: new Date(document.created_at).toISOString(),
          updatedAt: new Date(document.updated_at).toISOString(),
          versions: versions.map(version => ({
            id: version.id,
            number: version.version_number,
            name: version.name,
            mimeType: version.mime_type,
            status: version.status === 'superseded' ? 'retired' : version.status,
            createdAt: new Date(version.created_at).toISOString(),
          })),
        })
      }
      const manifest = Buffer.from(JSON.stringify({
        format: 'autoforge-personal-knowledge-export',
        version: 1,
        base: {
          id: base.id,
          name: base.name,
          kind: 'local',
          status: base.lifecycle_status,
          createdAt: new Date(base.created_at).toISOString(),
          updatedAt: new Date(base.updated_at).toISOString(),
        },
        documents: manifestDocuments,
      }, null, 2), 'utf8')
      retainedBytes += manifest.length
      entries.unshift({ name: 'manifest.json', contents: manifest })
      if (retainedBytes > maxBytes) throw new Error('Knowledge export exceeds its limit')
      archive = storedZip(entries)
      await this.dependencies.save(`knowledge-base-${base.id}.zip`, archive)
    } finally {
      archive?.fill(0)
      for (const entry of entries) entry.contents.fill(0)
    }
  }
}
