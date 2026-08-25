import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { toSafeAppError } from '@autoforge/shared'
import { readDecryptedObjectSnapshot, unwrapSnapshotFileKey } from './encrypted-object-store.js'

const MAX_EXPORT_VERSIONS = 256
const MAX_EXPORT_BYTES = 128 * 1024 * 1024

interface ExportObjectRow {
  documentId: string
  documentName: string
  mimeType: string
  documentStatus: string
  versionId: string
  versionNumber: number
  versionStatus: string
  createdAt: number
  relativeName: string
  wrappedFileKey: Buffer
  contentHash: string
}

interface ZipEntry {
  readonly name: string
  readonly bytes: Buffer
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function storedZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.bytes.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, entry.bytes)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(33, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(entry.bytes.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + entry.bytes.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function safeArchiveName(name: string): string {
  const cleaned = name.replaceAll(/[\\/\0]/g, '_').trim()
  return cleaned || 'document'
}

function requireManagedRelativeName(name: string): string {
  if (!/^[0-9a-f-]{36}\.afobj$/.test(name)) throw new Error('Knowledge object name is invalid')
  return name
}

export interface KnowledgeExportServiceOptions {
  readonly database: Database.Database
  readonly objectsDirectory: string
  loadObjectMasterKey(): Promise<Buffer>
  readonly now?: () => number
}

export class KnowledgeExportService {
  constructor(private readonly options: KnowledgeExportServiceOptions) {}

  async exportBase(knowledgeBaseId: string, outputPath: string): Promise<void> {
    const base = this.options.database.prepare(`
      SELECT id, name, status, created_at AS createdAt, updated_at AS updatedAt
      FROM knowledge_bases WHERE id = ?
    `).get(knowledgeBaseId) as {
      id: string; name: string; status: string; createdAt: number; updatedAt: number
    } | undefined
    if (!base) throw Object.assign(new Error('Knowledge base was not found'), { code: 'NOT_FOUND' })
    const aggregate = this.options.database.prepare(`
      SELECT count(*) AS versionCount, coalesce(sum(source_objects.byte_size), 0) AS byteSize
      FROM documents
      JOIN document_versions ON document_versions.document_id = documents.id
      JOIN source_objects ON source_objects.id = document_versions.source_object_id
      WHERE documents.knowledge_base_id = ?
    `).get(knowledgeBaseId) as { versionCount: number; byteSize: number }
    if (aggregate.versionCount > MAX_EXPORT_VERSIONS || aggregate.byteSize > MAX_EXPORT_BYTES) {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    const rows = this.options.database.prepare(`
      SELECT documents.id AS documentId, documents.name AS documentName,
        documents.mime_type AS mimeType, documents.status AS documentStatus,
        document_versions.id AS versionId, document_versions.version_number AS versionNumber,
        document_versions.status AS versionStatus, document_versions.created_at AS createdAt,
        source_objects.relative_name AS relativeName,
        source_objects.wrapped_file_key AS wrappedFileKey,
        source_objects.content_hash AS contentHash
      FROM documents
      JOIN document_versions ON document_versions.document_id = documents.id
      JOIN source_objects ON source_objects.id = document_versions.source_object_id
      WHERE documents.knowledge_base_id = ?
      ORDER BY documents.created_at, document_versions.version_number
    `).all(knowledgeBaseId) as ExportObjectRow[]

    const objectMasterKey = await this.options.loadObjectMasterKey()
    const entries: ZipEntry[] = []
    const documents = new Map<string, {
      id: string; name: string; mimeType: string; status: string
      versions: Array<{ id: string; number: number; status: string; createdAt: string; contentHash: string; original: string }>
    }>()
    try {
      for (const row of rows) {
        const fileKey = unwrapSnapshotFileKey(Buffer.from(row.wrappedFileKey), objectMasterKey)
        let bytes: Buffer
        try {
          bytes = await readDecryptedObjectSnapshot(
            join(this.options.objectsDirectory, requireManagedRelativeName(row.relativeName)),
            fileKey,
          )
        } finally {
          fileKey.fill(0)
        }
        const archivePath = `originals/${row.documentId}/v${row.versionNumber}/${safeArchiveName(row.documentName)}`
        entries.push({ name: archivePath, bytes })
        let document = documents.get(row.documentId)
        if (!document) {
          document = {
            id: row.documentId,
            name: row.documentName,
            mimeType: row.mimeType,
            status: row.documentStatus,
            versions: [],
          }
          documents.set(row.documentId, document)
        }
        document.versions.push({
          id: row.versionId,
          number: row.versionNumber,
          status: row.versionStatus === 'superseded' ? 'retired' : row.versionStatus,
          createdAt: new Date(row.createdAt).toISOString(),
          contentHash: row.contentHash,
          original: archivePath,
        })
      }
      const manifest = {
        formatVersion: 1,
        exportedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        knowledgeBase: {
          id: base.id,
          name: base.name,
          status: base.status,
          createdAt: new Date(base.createdAt).toISOString(),
          updatedAt: new Date(base.updatedAt).toISOString(),
        },
        documents: [...documents.values()],
      }
      entries.unshift({ name: 'manifest.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) })
      const archive = storedZip(entries)
      await mkdir(dirname(outputPath), { recursive: true })
      const temporaryPath = `${outputPath}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporaryPath, 'wx', 0o600)
        try {
          await handle.writeFile(archive)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporaryPath, outputPath)
      } catch (error) {
        try { await unlink(temporaryPath) } catch { /* Preserve the export error. */ }
        throw error
      } finally {
        archive.fill(0)
      }
    } finally {
      objectMasterKey.fill(0)
      for (const entry of entries) entry.bytes.fill(0)
    }
  }
}
