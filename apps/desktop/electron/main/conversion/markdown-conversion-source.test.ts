import { describe, expect, it } from 'vitest'
import { renderMarkdownConversionDocument } from './markdown-conversion-source.js'

describe('Markdown conversion source rendering', () => {
  it('renders Markdown structure into a styled HTML document before conversion', () => {
    const html = renderMarkdownConversionDocument([
      '# AutoForge',
      '',
      'This is **rendered** Markdown.',
      '',
      '- First item',
      '- Second item',
    ].join('\n'))

    expect(html).toContain('<h1>AutoForge</h1>')
    expect(html).toContain('This is <strong>rendered</strong> Markdown.')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>First item</li>')
    expect(html).not.toContain('# AutoForge')
    expect(html).not.toContain('- First item')
  })

  it('does not execute embedded HTML or fetch external Markdown images', () => {
    const html = renderMarkdownConversionDocument([
      '<script>alert("unsafe")</script>',
      '',
      '![remote diagram](https://private.example/diagram.png)',
    ].join('\n'))

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('https://private.example')
    expect(html).toContain('remote diagram')
  })

  it('emits a bounded table width that office document importers preserve', () => {
    const html = renderMarkdownConversionDocument([
      '| Rule | Example | Exception |',
      '| --- | --- | --- |',
      '| Compound nouns | mother-in-law → mothers-in-law | grown-up → grown-ups |',
    ].join('\n'))

    expect(html).toContain('<table width="90%">')
  })
})
