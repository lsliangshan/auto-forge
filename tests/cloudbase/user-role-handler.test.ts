import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createUserRoleHandler } from '../../cloudbase/user-roles/function/user-role-handler.js'

const context = { auth: { uid: 'admin_1' } }

describe('CloudBase user role function', () => {
  it('takes the caller only from trusted context and ensures the default role', async () => {
    const rpc = vi.fn().mockResolvedValue({
      userId: 'admin_1', role: 'user', capabilities: [], version: 0,
      updatedAt: '2026-08-21T00:00:00.000Z',
    })
    const handler = createUserRoleHandler({ rpc })

    await expect(handler({ action: 'ensureMyRole' }, context)).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({ userId: 'admin_1', role: 'user' }),
    })
    expect(rpc).toHaveBeenCalledWith('autoforge_ensure_my_role', {
      p_caller_user_id: 'admin_1',
    })
    await expect(handler({ action: 'ensureMyRole', userId: 'attacker' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
  })

  it('rejects calls without a platform identity', async () => {
    const handler = createUserRoleHandler({ rpc: vi.fn() })
    await expect(handler({ action: 'ensureMyRole', userId: 'attacker' }, {})).resolves.toEqual({
      ok: false, error: { code: 'AUTH_REQUIRED' },
    })
  })

  it('forwards only strict list and update fields to PostgreSQL RPC', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ items: [], page: 1, pageSize: 20, total: 0 })
      .mockResolvedValueOnce({
        userId: 'user_1', role: 'super_admin', version: 2,
        updatedAt: '2026-08-21T01:00:00.000Z',
      })
    const handler = createUserRoleHandler({ rpc })

    await handler({
      action: 'listUsers', page: 1, pageSize: 20,
      filter: { field: 'email', value: 'alice@example.com' },
    }, context)
    await handler({
      action: 'updateUserRole', requestId: 'request_1', targetUserId: 'user_1',
      newRole: 'super_admin', expectedVersion: 1,
    }, context)

    expect(rpc).toHaveBeenNthCalledWith(1, 'autoforge_list_users', {
      p_caller_user_id: 'admin_1', p_page: 1, p_page_size: 20,
      p_filter_field: 'email', p_filter_value: 'alice@example.com',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'autoforge_update_user_role', {
      p_caller_user_id: 'admin_1', p_request_id: 'request_1', p_target_user_id: 'user_1',
      p_new_role: 'super_admin', p_expected_version: 1,
    })
  })

  it('rejects unknown actions, extra fields and unsupported assigned roles', async () => {
    const rpc = vi.fn()
    const handler = createUserRoleHandler({ rpc })

    await expect(handler({ action: 'deleteUser', userId: 'user_1' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    await expect(handler({ action: 'listUsers', page: 1, pageSize: 20, extra: true }, context))
      .resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    await expect(handler({
      action: 'updateUserRole', requestId: 'request_1', targetUserId: 'user_1',
      newRole: 'support_operator', expectedVersion: 1,
    }, context)).resolves.toEqual({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns only stable PostgreSQL errors and masks all other failures', async () => {
    const stable = createUserRoleHandler({ rpc: vi.fn().mockRejectedValue({ code: 'LAST_SUPER_ADMIN' }) })
    const unknown = createUserRoleHandler({ rpc: vi.fn().mockRejectedValue(new Error('database password leaked')) })

    await expect(stable({
      action: 'updateUserRole', requestId: 'request_1', targetUserId: 'user_1',
      newRole: 'user', expectedVersion: 1,
    }, context)).resolves.toEqual({ ok: false, error: { code: 'LAST_SUPER_ADMIN' } })
    await expect(unknown({ action: 'ensureMyRole' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })
})

describe('CloudBase PostgreSQL user role migration', () => {
  it('contains the required private tables and transaction protections', async () => {
    const sql = await readFile(new URL('../../cloudbase/user-roles/migrations/0001_user_roles.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.app_user_roles')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.app_user_role_audit')
    expect(sql).toContain('REFERENCES auth.users(id) ON DELETE CASCADE')
    expect(sql).toContain('request_id varchar(128) NOT NULL UNIQUE')
    expect(sql).toContain('SELF_ROLE_CHANGE_FORBIDDEN')
    expect(sql).toContain('LAST_SUPER_ADMIN')
    expect(sql).toContain('ROLE_CONFLICT')
    expect(sql).toContain('REQUEST_ID_CONFLICT')
    expect(sql).toMatch(/REVOKE ALL ON (TABLE )?public\.app_user_roles FROM PUBLIC/)
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.autoforge_list_users')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.autoforge_list_users')
    expect(sql).toContain('TO service_role')
    expect(sql).toContain("SET search_path = pg_catalog, public")
  })
})
