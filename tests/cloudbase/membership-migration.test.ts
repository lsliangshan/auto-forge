import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const publishedUrl = new URL(
  '../../cloudbase/migrations/20260829230000_membership_control_plane.sql',
  import.meta.url,
)
const moduleUrl = new URL(
  '../../cloudbase/membership/migrations/0001_membership_control_plane.sql',
  import.meta.url,
)
const rollbackUrl = new URL(
  '../../cloudbase/membership/migrations/0001_membership_control_plane.rollback.sql',
  import.meta.url,
)

describe('CloudBase PostgreSQL membership control plane migration', () => {
  it('keeps the published migration mirrored and builds one authoritative audited ledger', async () => {
    const [published, module] = await Promise.all([
      readFile(publishedUrl, 'utf8'),
      readFile(moduleUrl, 'utf8'),
    ])

    expect(module).toBe(published)
    expect(published).toContain('CREATE TABLE IF NOT EXISTS public.membership_plans')
    expect(published).toContain('CREATE TABLE IF NOT EXISTS public.membership_accounts')
    expect(published).toContain('CREATE TABLE IF NOT EXISTS public.membership_events')
    expect(published).toContain('CREATE TABLE IF NOT EXISTS public.membership_requests')
    expect(published).toContain("('free', 1, 1, 1, 67108864, false)")
    expect(published).toContain("('pro', 1, 20, 500, 67108864, true)")
    expect(published).toContain('CREATE OR REPLACE FUNCTION public.autoforge_membership_get_current')
    expect(published).toContain('CREATE OR REPLACE FUNCTION public.autoforge_membership_get_target')
    expect(published).toContain('CREATE OR REPLACE FUNCTION public.autoforge_membership_mutate')
    expect(published).toContain('CREATE OR REPLACE FUNCTION public.autoforge_membership_list_audit')
    expect(published).toContain('p_expected_version integer')
    expect(published).toContain('pg_advisory_xact_lock')
    expect(published).toContain('MEMBERSHIP_CONFLICT')
    expect(published).toContain('SELF_MEMBERSHIP_CHANGE_FORBIDDEN')
    expect(published).toContain('REQUEST_ID_CONFLICT')
    expect(published).not.toContain('autoforge_ensure_my_role')
    expect(published).toMatch(/REVOKE ALL ON (TABLE )?public\.membership_accounts FROM PUBLIC/)
    expect(published).toContain('GRANT EXECUTE ON FUNCTION public.autoforge_membership_mutate')
  })

  it('uses a data-preserving rollback that only closes the new RPC surface', async () => {
    const rollback = await readFile(rollbackUrl, 'utf8')
    expect(rollback).toMatch(/(?:^|\n)BEGIN;[\s\S]*COMMIT;\s*$/)
    expect(rollback).toContain('REVOKE ALL ON FUNCTION public.autoforge_membership_mutate')
    expect(rollback).toContain('REVOKE ALL ON FUNCTION public.autoforge_membership_get_current')
    expect(rollback).toContain('REVOKE ALL ON FUNCTION public.autoforge_membership_list_audit')
    expect(rollback).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/i)
    expect(rollback).not.toMatch(/\bALTER\s+TABLE\b/i)
  })
})
