import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdownLanguage from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import MarkdownIt from 'markdown-it'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdownLanguage)
hljs.registerLanguage('python', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

function highlightCode(code: string, language: string): string {
  if (!language || !hljs.getLanguage(language)) return ''
  const languageClass = language.replace(/[^a-z0-9_-]/gi, '')
  const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value
  return `<pre><code class="hljs language-${languageClass}">${highlighted}</code></pre>`
}

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  highlight: highlightCode,
})

const INTERNAL_KNOWLEDGE_STATUS_LINE = /^\s*\[个人知识库:\s*(?:已找到依据\s+\d+\s+条|searching|found|consent_required|consent_denied|insufficient|source_unavailable|failed)\]\s*$/u

function stripInternalKnowledgeStatusLines(text: string): string {
  return text
    .split(/\r?\n/u)
    .filter(line => !INTERNAL_KNOWLEDGE_STATUS_LINE.test(line))
    .join('\n')
}

function normalizeMarkdownLayout(text: string): string {
  return stripInternalKnowledgeStatusLines(text)
    .replace(/^([ \t]*\d+[.)])[ \t]*\r?\n(?=[ \t]*\S)/gmu, '$1 ')
    .replace(/^([ \t]*\*\*[^*\r\n]+)\r?\n[ \t]*\*\*[ \t]*$/gmu, '\n$1**')
}

export function renderMarkdown(text: string): string {
  return markdown.render(normalizeMarkdownLayout(text))
}
