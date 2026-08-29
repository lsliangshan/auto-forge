import { parse, parseFragment } from 'parse5'
import type { ParsedDocument } from '../../main/knowledge/parser-protocol.js'
import { decodeUtf8, normalized } from './shared.js'

interface HtmlNode {
  readonly nodeName?: string
  readonly tagName?: string
  readonly value?: string
  readonly childNodes?: HtmlNode[]
}

const DROPPED_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'object', 'embed',
  'svg', 'math', 'canvas', 'audio', 'video', 'source', 'link', 'meta', 'base', 'form',
])
const BLOCK_ELEMENTS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'pre', 'blockquote', 'td', 'th',
])
const CONTAINER_ELEMENTS = new Set(['body', 'main', 'article', 'section', 'div'])

function textOf(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName && DROPPED_ELEMENTS.has(node.tagName)) return ''
  return (node.childNodes ?? []).map(textOf).join(' ')
}

function directContainerText(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (
    node.tagName
    && (DROPPED_ELEMENTS.has(node.tagName) || BLOCK_ELEMENTS.has(node.tagName) || CONTAINER_ELEMENTS.has(node.tagName))
  ) return ''
  return (node.childNodes ?? []).map(directContainerText).join(' ')
}

function htmlBlocks(root: HtmlNode): ParsedDocument['blocks'] {
  const blocks: ParsedDocument['blocks'] = []
  const headings: string[] = []
  const visit = (node: HtmlNode): void => {
    if (node.tagName && DROPPED_ELEMENTS.has(node.tagName)) return
    if (node.tagName && BLOCK_ELEMENTS.has(node.tagName)) {
      const text = normalized(textOf(node))
      if (text) {
        if (/^h[1-6]$/.test(node.tagName)) {
          const depth = Number(node.tagName[1])
          headings.splice(depth - 1)
          headings[depth - 1] = text
        }
        blocks.push({
          id: `html-${blocks.length + 1}`,
          text,
          coordinate: { kind: 'html', path: headings.filter(Boolean), blockIndex: blocks.length },
        })
      }
      return
    }
    if (node.tagName && CONTAINER_ELEMENTS.has(node.tagName)) {
      const text = normalized((node.childNodes ?? []).map(directContainerText).join(' '))
      if (text) {
        blocks.push({
          id: `html-${blocks.length + 1}`,
          text,
          coordinate: { kind: 'html', path: headings.filter(Boolean), blockIndex: blocks.length },
        })
      }
    }
    for (const child of node.childNodes ?? []) visit(child)
  }
  visit(root)
  return blocks
}

export function safeHtmlText(value: string): string {
  return normalized(textOf(parseFragment(value) as unknown as HtmlNode))
}

export function parseHtml(bytes: Uint8Array): ParsedDocument {
  const root = parse(decodeUtf8(bytes)) as unknown as HtmlNode
  const blocks = htmlBlocks(root)
  return { mediaType: 'text/html', text: blocks.map(block => block.text).join('\n'), blocks }
}
