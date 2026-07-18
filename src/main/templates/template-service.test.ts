// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TemplateService } from './template-service'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'autoforge-template-'))
  roots.push(root)
  return root
}

describe('TemplateService', () => {
  it('copies the complete template into a named root directory', () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const target = join(root, 'target')
    mkdirSync(join(source, 'dist'), { recursive: true })
    mkdirSync(target)
    writeFileSync(join(source, 'manifest.json'), '{}')
    writeFileSync(join(source, 'dist', 'index.js'), 'export {}')

    const exported = new TemplateService(source).exportTemplate(target)

    expect(exported).toBe(join(target, 'auto-forge-tool-template'))
    expect(readFileSync(join(exported, 'dist', 'index.js'), 'utf8')).toBe('export {}')
  })

  it('refuses to overwrite an existing template directory', () => {
    const root = temporaryRoot()
    const source = join(root, 'source')
    const target = join(root, 'target')
    mkdirSync(source)
    mkdirSync(join(target, 'auto-forge-tool-template'), { recursive: true })

    expect(() => new TemplateService(source).exportTemplate(target)).toThrow(/already exists/i)
  })
})
