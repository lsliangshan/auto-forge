export interface BrowserLocator {
  kind: 'css' | 'role'
  value: string
  name?: string
}

const roles = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell',
  'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition',
  'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic',
  'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem',
  'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar',
  'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab',
  'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem',
])

export function parseBrowserLocator(value: string): BrowserLocator | undefined {
  if (value.startsWith('css=')) {
    const selector = value.slice('css='.length)
    if (selector && !selector.includes('>>')) return { kind: 'css', value: selector }
    return undefined
  }

  const match = /^role=([a-z]+)(?:\[name=("(?:[^"\\]|\\.)*")\])?$/.exec(value)
  if (!match || !roles.has(match[1]!)) return undefined
  if (!match[2]) return { kind: 'role', value: match[1]! }
  try {
    const name = JSON.parse(match[2]) as unknown
    return typeof name === 'string' && name ? { kind: 'role', value: match[1]!, name } : undefined
  } catch {
    return undefined
  }
}

export function isBrowserLocator(value: string): boolean {
  return parseBrowserLocator(value) !== undefined
}
