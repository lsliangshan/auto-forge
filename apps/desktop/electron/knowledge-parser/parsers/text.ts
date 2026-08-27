import type { ParsedDocument } from '../../main/knowledge/parser-protocol.js'
import { decodeUtf8, normalized } from './shared.js'

export function parseText(bytes: Uint8Array): ParsedDocument {
  const text = normalized(decodeUtf8(bytes))
  const lines = text.split('\n')
  let character = 0
  const blocks: ParsedDocument['blocks'] = []
  lines.forEach((line, index) => {
    const charStart = character
    character += line.length + (index < lines.length - 1 ? 1 : 0)
    if (!line) return
    blocks.push({
      id: `line-${index + 1}`,
      text: line,
      coordinate: {
        kind: 'txt',
        lineStart: index + 1,
        lineEnd: index + 1,
        charStart,
        charEnd: charStart + line.length,
      },
    })
  })
  return { mediaType: 'text/plain', text, blocks }
}
