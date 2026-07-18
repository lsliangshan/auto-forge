// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('database runtime', () => {
  it('uses the built-in SQLite runtime without native ABI rebuild scripts', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }

    expect(packageJson.dependencies).not.toHaveProperty('better-sqlite3')
    expect(Object.values(packageJson.scripts).join(' ')).not.toContain('rebuild:electron')
  })
})
