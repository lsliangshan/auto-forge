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
      expect.arrayContaining(['schema_migrations', 'app_settings', 'installed_tools', 'workflow_projects', 'installed_workflows', 'encrypted_sessions'])
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

  it('stores projects and atomically points to installed workflow versions', () => {
    database = new AppDatabase(':memory:')
    database.initialize()
    database.upsertWorkflowProject({ id: 'project-1', path: '/tmp/project', slug: 'fixture', name: 'Fixture', version: '1.0.0', status: 'READY', codeSha256: 'a'.repeat(64), updatedAt: '2026-07-19T00:00:00.000Z' })
    database.markWorkflowInstalled({ workflowId: 'workflow-1', slug: 'fixture', version: '1.0.0', installPath: '/tmp/installed', manifestJson: '{}', installedAt: '2026-07-19T00:00:00.000Z' })
    expect(database.listWorkflowProjects()).toHaveLength(1)
    expect(database.getInstalledWorkflow('workflow-1')?.version).toBe('1.0.0')
  })
})
