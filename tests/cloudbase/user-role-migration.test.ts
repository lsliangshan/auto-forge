import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const publishedBaseUrl = new URL(
  '../../cloudbase/migrations/20260821105102_user_roles.sql',
  import.meta.url,
)
const moduleBaseUrl = new URL(
  '../../cloudbase/user-roles/migrations/0001_user_roles.sql',
  import.meta.url,
)
const publishedForwardUrl = new URL(
  '../../cloudbase/migrations/20260828200000_user_role_knowledge_entitlement.sql',
  import.meta.url,
)
const moduleForwardUrl = new URL(
  '../../cloudbase/user-roles/migrations/0002_knowledge_entitlement.sql',
  import.meta.url,
)
const moduleRollbackUrl = new URL(
  '../../cloudbase/user-roles/migrations/0002_knowledge_entitlement.rollback.sql',
  import.meta.url,
)
const readmeUrl = new URL('../../cloudbase/user-roles/README.md', import.meta.url)

function extractFunction(sql: string, name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`
  const start = sql.indexOf(marker)
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0)
  const bodyStart = sql.indexOf('AS $$', start)
  const end = sql.indexOf('$$;', bodyStart + 5)
  expect(bodyStart, `${name} has a dollar-quoted body`).toBeGreaterThan(start)
  expect(end, `${name} closes its dollar-quoted body`).toBeGreaterThan(bodyStart)
  return sql.slice(start, end + 3)
}

describe('CloudBase PostgreSQL user role migration', () => {
  it('preserves the published base bytes and keeps the entitlement forward mirrors identical', async () => {
    const [publishedBase, moduleBase, publishedForward, moduleForward] = await Promise.all([
      readFile(publishedBaseUrl, 'utf8'),
      readFile(moduleBaseUrl, 'utf8'),
      readFile(publishedForwardUrl, 'utf8'),
      readFile(moduleForwardUrl, 'utf8'),
    ])

    expect(moduleBase).toBe(publishedBase)
    expect(createHash('sha256').update(publishedBase).digest('hex'))
      .toBe('d5d3b2f95076a4dc206db70ad675dca0b0cfa4d6d1e532e85568253a7267806d')
    expect(moduleForward).toBe(publishedForward)
    expect(publishedForward).toContain('ADD COLUMN IF NOT EXISTS knowledge_entitlement jsonb')
    expect(publishedForward).toContain("'knowledgeEntitlement', role_row.knowledge_entitlement")
  })

  it('keeps accepted entitlement data intact while restoring the previous RPC projection', async () => {
    const [base, forward, rollback] = await Promise.all([
      readFile(moduleBaseUrl, 'utf8'),
      readFile(moduleForwardUrl, 'utf8'),
      readFile(moduleRollbackUrl, 'utf8'),
    ])

    expect(rollback).toMatch(/(?:^|\n)BEGIN;[\s\S]*COMMIT;\s*$/)
    expect(rollback).toContain(
      'CREATE OR REPLACE FUNCTION public.autoforge_ensure_my_role(p_caller_user_id varchar)',
    )
    expect(extractFunction(rollback, 'autoforge_ensure_my_role'))
      .toBe(extractFunction(base, 'autoforge_ensure_my_role'))
    expect(rollback).toContain("'updatedAt', to_char(role_row.updated_at")
    expect(rollback).not.toContain("'knowledgeEntitlement', role_row.knowledge_entitlement")
    expect(rollback).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/i)
    expect(rollback).not.toMatch(/\bALTER\s+TABLE\b/i)
    expect(rollback).toContain(
      'REVOKE ALL ON FUNCTION public.autoforge_ensure_my_role(varchar) FROM PUBLIC, anon, authenticated',
    )
    expect(rollback).toContain(
      'GRANT EXECUTE ON FUNCTION public.autoforge_ensure_my_role(varchar) TO service_role',
    )
    expect(forward).toContain('ADD COLUMN IF NOT EXISTS knowledge_entitlement jsonb')
    expect(forward).toContain('DROP CONSTRAINT IF EXISTS app_user_roles_knowledge_entitlement_check')
    expect(forward).toContain('ADD CONSTRAINT app_user_roles_knowledge_entitlement_check CHECK')
  })

  it('documents forward verification before the data-preserving rollback sequence', async () => {
    const readme = await readFile(readmeUrl, 'utf8')
    const baseIndex = readme.indexOf('../../migrations/20260821105102_user_roles.sql')
    const additiveIndex = readme.indexOf(
      '../../migrations/20260828200000_user_role_knowledge_entitlement.sql',
    )
    const verificationIndex = readme.indexOf('验证顺序')
    const rollbackIndex = readme.indexOf('0002_knowledge_entitlement.rollback.sql')

    expect(baseIndex).toBeGreaterThanOrEqual(0)
    expect(additiveIndex).toBeGreaterThan(baseIndex)
    expect(verificationIndex).toBeGreaterThan(additiveIndex)
    expect(rollbackIndex).toBeGreaterThan(verificationIndex)
    expect(readme).toContain('保留 `knowledge_entitlement` 列、约束和已有值')
    expect(readme).not.toMatch(/(?:执行|运行)\s+(?:DROP|TRUNCATE|DELETE)\b/i)
    const executableBlocks = [...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
      .map(match => match[1])
      .join('\n')
    expect(executableBlocks).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/i)
  })

  it('keeps CloudBase bigint auth ids exact across the string API boundary', async () => {
    const [sql, versionedSql] = await Promise.all([
      readFile(moduleBaseUrl, 'utf8'),
      readFile(publishedBaseUrl, 'utf8'),
    ])

    expect(versionedSql).toBe(sql)
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.app_user_roles')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.app_user_role_audit')
    expect(sql).toContain('user_id bigint PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE')
    expect(sql).toContain("'userId', role_row.user_id::text")
    expect(sql).not.toContain("'knowledgeEntitlement', role_row.knowledge_entitlement")
    expect(sql).not.toContain('knowledge_entitlement jsonb')
    expect(sql).toContain('users.id::text = p_caller_user_id')
    expect(sql).toContain('users.id::text = p_target_user_id')
    expect(sql).not.toMatch(/users\.id\s*=\s*p_(?:caller|target)_user_id/)
    expect(sql).not.toContain('roles.user_id = users.id::text')
    expect(sql).toContain("existing_role varchar(63) := 'user'")
    expect(sql).not.toMatch(/\bcurrent_role\b/)
    expect(sql).toContain('request_id varchar(128) NOT NULL UNIQUE')
    expect(sql).toContain('SELF_ROLE_CHANGE_FORBIDDEN')
    expect(sql).toContain('LAST_SUPER_ADMIN')
    expect(sql).toContain('ROLE_CONFLICT')
    expect(sql).toContain('REQUEST_ID_CONFLICT')
    expect(sql).toContain("'total', (SELECT total FROM totals)")
    expect(sql).toMatch(/REVOKE ALL ON (TABLE )?public\.app_user_roles FROM PUBLIC/)
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.autoforge_list_users')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.autoforge_list_users')
    expect(sql).toContain('TO service_role')
    expect(sql).toContain("SET search_path = pg_catalog, public")
  })
})
