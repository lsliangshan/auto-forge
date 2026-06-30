import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ensureAppDatabase } from './app-database.ts'

describe('ensureAppDatabase', () => {
  it('creates the database directory and schema migration table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autoforge-db-'))
    const databasePath = join(dir, 'nested', 'autoforge.sqlite')
    const calls: string[] = []

    class FakeDatabase {
      readonly path: string

      constructor(path: string) {
        this.path = path
        calls.push(`open:${path}`)
      }

      pragma(statement: string) {
        calls.push(`pragma:${statement}`)
      }

      exec(statement: string) {
        calls.push(`exec:${statement.includes('schema_migrations')}`)
      }

      close() {
        calls.push('close')
      }
    }

    try {
      const result = ensureAppDatabase(databasePath, FakeDatabase)
      assert.equal(result.path, databasePath)
      assert.equal(existsSync(join(dir, 'nested')), true)
      assert.deepEqual(calls, [
        `open:${databasePath}`,
        'pragma:journal_mode = WAL',
        'exec:true',
        'close'
      ])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  })
})
