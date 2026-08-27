import Database from 'better-sqlite3'
import { initializeKnowledgeSchema } from './knowledge-schema.js'

export class MemoryKnowledgeObjects {
  readonly values = new Map<string, Buffer>()
  #next = 1

  async put(contents: Buffer): Promise<{ objectId: string; byteLength: number }> {
    const objectId = this.#next.toString(16).padStart(32, '0')
    this.#next += 1
    this.values.set(objectId, Buffer.from(contents))
    return { objectId, byteLength: contents.length }
  }

  async read(objectId: string): Promise<Buffer> {
    const value = this.values.get(objectId)
    if (!value) throw new Error('Knowledge object is unavailable')
    return Buffer.from(value)
  }

  async delete(objectId: string): Promise<void> {
    this.values.delete(objectId)
  }

  close(): void {}
}

export function memoryKnowledgeStore() {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  initializeKnowledgeSchema(database)
  const objects = new MemoryKnowledgeObjects()
  let closes = 0
  return {
    database,
    objects,
    store: {
      database,
      databasePath: ':memory:',
      ownerRoot: '/memory',
      capabilities: {
        available: true as const,
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        tempStore: 'memory' as const,
        fts5: true as const,
        trigram: true as const,
      },
      objects,
      rotateKey: async () => undefined,
      close: async () => { closes += 1 },
    },
    closes: () => closes,
  }
}

export function parsedText(text: string) {
  return {
    mediaType: 'text/plain' as const,
    text,
    blocks: text.split('\n').map((line, index) => ({
      id: `line-${index + 1}`,
      text: line,
      coordinate: {
        kind: 'txt' as const,
        lineStart: index + 1,
        lineEnd: index + 1,
        charStart: text.split('\n').slice(0, index).reduce((sum, part) => sum + part.length + 1, 0),
        charEnd: text.split('\n').slice(0, index).reduce((sum, part) => sum + part.length + 1, 0) + line.length,
      },
    })),
  }
}
