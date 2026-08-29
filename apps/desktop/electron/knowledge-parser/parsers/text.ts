import type { ParsedDocument } from '../../main/knowledge/parser-protocol.js'
import { decodeUtf8, normalized } from './shared.js'

export function parseText(bytes: Uint8Array): ParsedDocument {
  const lines = normalized(decodeUtf8(bytes)).split('\n')
  const blocks: ParsedDocument['blocks'] = []
  let outputCharacter = 0
  lines.forEach((line, index) => {
    if (!line) return
    const charStart = outputCharacter
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
    outputCharacter += line.length + 1
  })
  const text = blocks.map(block => block.text).join('\n')
  return { mediaType: 'text/plain', text, blocks }
}
