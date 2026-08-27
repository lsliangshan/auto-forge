import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { ParsedDocument } from '../../main/knowledge/parser-protocol.js'
import { safeHtmlText } from './html.js'
import { decodeUtf8, normalized } from './shared.js'

interface MarkdownNode {
  readonly type?: string
  readonly value?: string
  readonly depth?: number
  readonly children?: MarkdownNode[]
}

const ACTIVE_HTML = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed',
  'svg', 'math', 'canvas', 'audio', 'video', 'source', 'link', 'meta', 'base', 'form',
])

interface ActiveHtmlState {
  readonly depths: Map<string, number>
  pendingTag: string
}

function consumeHtml(value: string, state: ActiveHtmlState): void {
  const source = state.pendingTag + value
  state.pendingTag = ''
  let start = source.indexOf('<')
  while (start >= 0) {
    let quote = ''
    let end = start + 1
    let resynchronized = false
    for (; end < source.length; end += 1) {
      const character = source[end]!
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '<') {
        start = end
        resynchronized = true
        break
      } else if (character === '>') {
        break
      }
    }
    if (resynchronized) continue
    if (end >= source.length) {
      state.pendingTag = source.slice(start)
      return
    }
    const boundary = source.slice(start + 1, end).trim()
    const match = boundary.match(/^\/?\s*([a-z0-9-]+)\b/i)
    const tag = match?.[1]?.toLowerCase()
    if (tag && ACTIVE_HTML.has(tag)) {
      if (boundary.startsWith('/')) {
        state.depths.set(tag, Math.max(0, (state.depths.get(tag) ?? 0) - 1))
      } else if (!boundary.endsWith('/')) {
        state.depths.set(tag, (state.depths.get(tag) ?? 0) + 1)
      }
    }
    start = source.indexOf('<', end + 1)
  }
}

function active(state: ActiveHtmlState): boolean {
  return [...state.depths.values()].some(depth => depth > 0)
}

function textOf(node: MarkdownNode, state: ActiveHtmlState): string {
  if (node.type === 'html') {
    const wasActive = active(state)
    consumeHtml(node.value ?? '', state)
    if (wasActive || active(state)) return ''
    return safeHtmlText(node.value ?? '')
  }
  if (typeof node.value === 'string') return active(state) ? '' : node.value
  return (node.children ?? []).map(child => textOf(child, state)).join('')
}

export function parseMarkdown(bytes: Uint8Array): ParsedDocument {
  const root = unified().use(remarkParse).parse(decodeUtf8(bytes)) as MarkdownNode
  const blocks: ParsedDocument['blocks'] = []
  const headings: string[] = []
  const state: ActiveHtmlState = { depths: new Map(), pendingTag: '' }
  for (const node of root.children ?? []) {
    const text = normalized(textOf(node, state))
    if (!text) continue
    if (node.type === 'heading') {
      const depth = node.depth ?? 1
      headings.splice(depth - 1)
      headings[depth - 1] = text
    }
    blocks.push({
      id: `md-${blocks.length + 1}`,
      text,
      coordinate: { kind: 'markdown', path: headings.filter(Boolean), blockIndex: blocks.length },
    })
  }
  return { mediaType: 'text/markdown', text: blocks.map(block => block.text).join('\n'), blocks }
}
