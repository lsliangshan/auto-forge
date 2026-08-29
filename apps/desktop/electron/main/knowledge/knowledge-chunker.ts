import type { ParsedDocument, ParserBlock } from './parser-protocol.js'

const TARGET_CHUNK_CHARACTERS = 600
const CHUNK_OVERLAP_CHARACTERS = 100
const MINIMUM_BOUNDARY_CHARACTERS = 420
const MAXIMUM_CHUNKS = 10_000
const BOUNDARY = /[\n。！？；.!?;]/u

export const LOCAL_KNOWLEDGE_CHUNKING_REVISION = 2

export interface LocalKnowledgeChunk {
  readonly sourceBlockIndex: number
  readonly body: string
  readonly coordinate: ParserBlock['coordinate']
}

function searchableBlockText(block: ParserBlock): string {
  const path = block.coordinate.kind === 'docx'
    ? block.coordinate.headingPath
    : block.coordinate.kind === 'markdown' || block.coordinate.kind === 'html'
      ? block.coordinate.path
      : []
  const heading = path.filter(Boolean).join(' > ')
  return heading && !block.text.startsWith(heading)
    ? `${heading}\n${block.text}`
    : block.text
}

function preferredEnd(characters: readonly string[], start: number): number {
  const maximum = Math.min(characters.length, start + TARGET_CHUNK_CHARACTERS)
  if (maximum === characters.length) return maximum
  const minimum = Math.min(maximum, start + MINIMUM_BOUNDARY_CHARACTERS)
  for (let index = maximum; index > minimum; index -= 1) {
    if (BOUNDARY.test(characters[index - 1]!)) return index
  }
  return maximum
}

export function buildLocalKnowledgeChunks(document: ParsedDocument): LocalKnowledgeChunk[] {
  const blockRanges: Array<{
    start: number
    end: number
    blockIndex: number
    coordinate: ParserBlock['coordinate']
  }> = []
  const characters: string[] = []
  for (const [blockIndex, block] of document.blocks.entries()) {
    if (characters.length > 0) characters.push('\n')
    const start = characters.length
    characters.push(...Array.from(searchableBlockText(block)))
    blockRanges.push({ start, end: characters.length, blockIndex, coordinate: block.coordinate })
  }

  const chunks: LocalKnowledgeChunk[] = []
  let start = 0
  while (start < characters.length) {
    const end = preferredEnd(characters, start)
    const centre = start + Math.floor((end - start) / 2)
    const source = blockRanges.find(range => range.end > centre)
      ?? blockRanges.at(-1)
    if (!source || end <= start) break
    const body = characters.slice(start, end).join('').trim()
    if (body) {
      chunks.push({
        sourceBlockIndex: source.blockIndex,
        body,
        coordinate: source.coordinate,
      })
      if (chunks.length > MAXIMUM_CHUNKS) throw new Error('Knowledge chunk limit exceeded')
    }
    if (end === characters.length) break
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARACTERS)
  }
  return chunks
}
