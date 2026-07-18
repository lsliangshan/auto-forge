// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './app-database'

let database: AppDatabase | undefined

afterEach(() => database?.close())

describe('AppDatabase', () => {
  it('creates the required tables idempotently', () => {
    database = new AppDatabase(':memory:')
    database.initialize()
    database.initialize()

    expect(database.listTableNames()).toEqual(
      expect.arrayContaining(['schema_migrations', 'app_settings', 'installed_tools'])
    )
  })

  it('persists settings and installed tool ids', () => {
    database = new AppDatabase(':memory:')
    database.initialize()
    database.setSetting('theme', 'dark')
    database.markToolInstalled('web-collector', '2.3.1', '2026-07-18T08:00:00.000Z')

    expect(database.getSetting('theme')).toBe('dark')
    expect(database.listInstalledToolIds()).toEqual(['web-collector'])
  })
})
