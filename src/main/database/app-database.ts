import { DatabaseSync } from 'node:sqlite'
import { migrations } from './migrations'

export interface WorkflowProjectRecord {
  id: string; path: string; slug: string; name: string; version: string
  status: string; codeSha256?: string; buildError?: string; updatedAt: string
}

export interface InstalledWorkflowRecord {
  workflowId: string; slug: string; version: string; installPath: string
  manifestJson: string; installedAt: string
}

export class AppDatabase {
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.database = new DatabaseSync(path)
  }

  initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `)

    const currentVersion = this.database
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number }

    for (const migration of migrations.filter(({ version }) => version > currentVersion.version)) {
      this.database.exec('BEGIN')
      try {
        this.database.exec(migration.sql)
        this.database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
    }
  }

  listTableNames(): string[] {
    return (
      this.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name)
  }

  getSetting(key: string): string | undefined {
    const row = this.database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  setSetting(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  markToolInstalled(toolId: string, version: string, installedAt: string): void {
    this.database
      .prepare(
        `INSERT INTO installed_tools (tool_id, version, installed_at) VALUES (?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET version = excluded.version, installed_at = excluded.installed_at`
      )
      .run(toolId, version, installedAt)
  }

  listInstalledToolIds(): string[] {
    return (
      this.database.prepare('SELECT tool_id FROM installed_tools ORDER BY installed_at DESC').all() as Array<{
        tool_id: string
      }>
    ).map(({ tool_id }) => tool_id)
  }

  upsertWorkflowProject(project: WorkflowProjectRecord): void {
    this.database.prepare(`INSERT INTO workflow_projects
      (id, path, slug, name, version, status, code_sha256, build_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, slug=excluded.slug, name=excluded.name,
      version=excluded.version, status=excluded.status, code_sha256=excluded.code_sha256,
      build_error=excluded.build_error, updated_at=excluded.updated_at`).run(
      project.id, project.path, project.slug, project.name, project.version, project.status,
      project.codeSha256 ?? null, project.buildError ?? null, project.updatedAt
    )
  }

  listWorkflowProjects(): WorkflowProjectRecord[] {
    return (this.database.prepare('SELECT * FROM workflow_projects ORDER BY updated_at DESC').all() as Array<Record<string, string | null>>).map((row) => ({
      id: row.id!, path: row.path!, slug: row.slug!, name: row.name!, version: row.version!, status: row.status!,
      codeSha256: row.code_sha256 ?? undefined, buildError: row.build_error ?? undefined, updatedAt: row.updated_at!
    }))
  }

  markWorkflowInstalled(record: InstalledWorkflowRecord): void {
    this.database.prepare(`INSERT INTO installed_workflows
      (workflow_id, slug, version, install_path, manifest_json, installed_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET slug=excluded.slug, version=excluded.version,
      install_path=excluded.install_path, manifest_json=excluded.manifest_json, installed_at=excluded.installed_at`).run(
      record.workflowId, record.slug, record.version, record.installPath, record.manifestJson, record.installedAt
    )
  }

  getInstalledWorkflow(workflowId: string): InstalledWorkflowRecord | undefined {
    const row = this.database.prepare('SELECT * FROM installed_workflows WHERE workflow_id = ?').get(workflowId) as Record<string, string> | undefined
    return row ? { workflowId: row.workflow_id, slug: row.slug, version: row.version, installPath: row.install_path, manifestJson: row.manifest_json, installedAt: row.installed_at } : undefined
  }

  listInstalledWorkflows(): InstalledWorkflowRecord[] {
    return (this.database.prepare('SELECT workflow_id FROM installed_workflows ORDER BY installed_at DESC').all() as Array<{ workflow_id: string }>).map(({ workflow_id }) => this.getInstalledWorkflow(workflow_id)!)
  }

  setEncryptedSession(encryptedRefreshToken: string, userJson: string): void {
    this.database.prepare(`INSERT INTO encrypted_sessions (id, encrypted_refresh_token, user_json, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token, user_json=excluded.user_json, updated_at=excluded.updated_at`).run(encryptedRefreshToken, userJson, new Date().toISOString())
  }

  getEncryptedSession(): { encryptedRefreshToken: string; userJson: string } | undefined {
    const row = this.database.prepare('SELECT encrypted_refresh_token, user_json FROM encrypted_sessions WHERE id = 1').get() as { encrypted_refresh_token: string; user_json: string } | undefined
    return row ? { encryptedRefreshToken: row.encrypted_refresh_token, userJson: row.user_json } : undefined
  }

  clearEncryptedSession(): void { this.database.prepare('DELETE FROM encrypted_sessions WHERE id = 1').run() }

  close(): void {
    this.database.close()
  }
}
