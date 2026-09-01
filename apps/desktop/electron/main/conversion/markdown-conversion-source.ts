import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })

markdown.renderer.rules.image = (tokens, index) => {
  const alt = markdown.utils.escapeHtml(tokens[index]?.content ?? '')
  return `<span class="markdown-image-alt">${alt}</span>`
}
markdown.renderer.rules.table_open = () => '<table width="90%">\n'

const documentStyles = `
@page { size: A4; margin: 18mm 16mm; }
html { color: #1f2937; background: #ffffff; font-family: "Arial Unicode MS", "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 11pt; line-height: 1.65; }
body { margin: 0; }
main { max-width: 100%; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; margin: 1.35em 0 .55em; color: #111827; line-height: 1.3; }
h1 { border-bottom: 1px solid #d1d5db; padding-bottom: .3em; font-size: 2em; }
h2 { font-size: 1.55em; }
h3 { font-size: 1.25em; }
p { margin: 0 0 1em; }
ul, ol { margin: .65em 0 1em; padding-left: 2em; }
li + li { margin-top: .25em; }
blockquote { margin: 1em 0; border-left: 3px solid #9ca3af; padding-left: 1em; color: #4b5563; }
code { border-radius: 3px; padding: .1em .3em; background: #f3f4f6; font-family: ui-monospace, SFMono-Regular, Menlo, "Arial Unicode MS", "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", monospace; font-size: .9em; }
pre { break-inside: avoid; overflow-wrap: normal; margin: 1em 0; border-radius: 6px; padding: .8em 1em; color: #e5e7eb; background: #111827; white-space: pre-wrap; }
pre code { padding: 0; color: inherit; background: transparent; }
table { width: 90%; max-width: 100%; table-layout: fixed; margin: 1em auto; border-collapse: collapse; font-size: 9pt; }
th, td { border: 1px solid #d1d5db; padding: .35em .45em; overflow-wrap: anywhere; word-break: break-word; text-align: left; vertical-align: top; }
th { background: #f3f4f6; }
hr { margin: 1.5em 0; border: 0; border-top: 1px solid #d1d5db; }
a { color: #2563eb; text-decoration: underline; }
.markdown-image-alt { color: #6b7280; font-style: italic; }
`

export function renderMarkdownConversionDocument(source: string): string {
  const body = markdown.render(source)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>${documentStyles}</style>
</head>
<body><main>${body}</main></body>
</html>
`
}
