import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createPostgresRpcClient,
  createUserRoleHandler,
} from '../../cloudbase/user-roles/function/user-role-handler.js'

const context = { auth: { uid: 'admin_1' } }

describe('CloudBase user role function', () => {
  it('uses a CommonJS entry compatible with the CloudBase index.main loader', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../../cloudbase/user-roles/function/package.json', import.meta.url),
      'utf8',
    ))
    const entry = await readFile(
      new URL('../../cloudbase/user-roles/function/index.js', import.meta.url),
      'utf8',
    )

    expect(packageJson.type).not.toBe('module')
    expect(entry).toContain('exports.main = main')
    expect(entry).not.toMatch(/\bexport\s+(?:default|async|function|const|let|var|class)/)
  })

  it('calls the CloudBase PostgreSQL RPC endpoint with a server-only bearer key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ userId: '2089908515857502208', role: 'user' }),
    })
    const rpc = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest/',
      serviceKey: 'server-secret',
      fetchImpl,
    })

    await expect(rpc('autoforge_ensure_my_role', {
      p_caller_user_id: '2089908515857502208',
    })).resolves.toEqual({ userId: '2089908515857502208', role: 'user' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://autoforge.example/v1/rdb/rest/rpc/autoforge_ensure_my_role',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer server-secret',
          'content-type': 'application/json',
        },
      }),
    )

    const failed = createPostgresRpcClient({
      baseUrl: 'https://autoforge.example/v1/rdb/rest',
      serviceKey: 'server-secret',
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: vi.fn().mockResolvedValue({ message: 'FORBIDDEN' }),
      }),
    })
    await expect(failed('autoforge_list_users', {})).rejects.toEqual({ code: 'FORBIDDEN' })
  })

  it('takes the caller only from trusted context and ensures the default role', async () => {
    const rpc = vi.fn().mockResolvedValue({
      userId: 'admin_1', role: 'user', capabilities: [], version: 0,
      updatedAt: '2026-08-21T00:00:00.000Z',
    })
    const handler = createUserRoleHandler({ rpc })

    await expect(handler({
      action: 'ensureMyRole',
      userId: 'attacker',
      uid: 'attacker',
      platformTraceId: 'trace_1',
    }, context)).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({ userId: 'admin_1', role: 'user' }),
    })
    expect(rpc).toHaveBeenCalledWith('autoforge_ensure_my_role', {
      p_caller_user_id: 'admin_1',
    })
  })

  it('returns only a nullable strict opaque signed entitlement from the role RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({
      userId: 'admin_1', role: 'user', capabilities: [], version: 0,
      updatedAt: '2026-08-21T00:00:00.000Z',
      knowledgeEntitlement: { payload: 'eA', signature: 'eA' },
    })
    const handler = createUserRoleHandler({ rpc })
    await expect(handler({ action: 'ensureMyRole' }, context)).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        knowledgeEntitlement: { payload: 'eA', signature: 'eA' },
      }),
    })

    rpc.mockResolvedValueOnce({
      userId: 'admin_1', role: 'user', capabilities: [], version: 0,
      updatedAt: '2026-08-21T00:00:00.000Z',
      knowledgeEntitlement: { payload: 'eA', signature: 'eA', privateKey: 'forbidden' },
    })
    await expect(handler({ action: 'ensureMyRole' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INTERNAL_ERROR' },
    })
  })

  it('ignores CloudBase-injected event identity metadata while trusting only the function context', async () => {
    const rpc = vi.fn().mockResolvedValue({
      userId: 'admin_1', role: 'user', capabilities: [], version: 0,
      updatedAt: '2026-08-21T00:00:00.000Z',
    })
    const handler = createUserRoleHandler({ rpc })

    await expect(handler({
      action: 'ensureMyRole',
      openid: 'platform-injected-openid',
      userInfo: { uid: 'attacker' },
      source: 'cloudbase-runtime',
    }, context)).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({ userId: 'admin_1', role: 'user' }),
    })
    expect(rpc).toHaveBeenCalledWith('autoforge_ensure_my_role', {
      p_caller_user_id: 'admin_1',
    })
  })

  it('reads a Web user UID from the CloudBase event context environment', async () => {
    const rpc = vi.fn().mockResolvedValue({
      userId: '2090350246298132480', role: 'super_admin', capabilities: ['manage_users'], version: 1,
      updatedAt: '2026-08-21T11:14:02.802Z',
    })
    const handler = createUserRoleHandler({ rpc })

    await expect(handler({ action: 'ensureMyRole' }, {
      environment: JSON.stringify({ TCB_UUID: '2090350246298132480' }),
    })).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({ userId: '2090350246298132480', role: 'super_admin' }),
    })
    expect(rpc).toHaveBeenCalledWith('autoforge_ensure_my_role', {
      p_caller_user_id: '2090350246298132480',
    })
  })

  it('rejects calls without a platform identity', async () => {
    const handler = createUserRoleHandler({ rpc: vi.fn() })
    await expect(handler({ action: 'ensureMyRole', userId: 'attacker' }, {})).resolves.toEqual({
      ok: false, error: { code: 'AUTH_REQUIRED' },
    })
  })

  it('forwards only validated business fields to PostgreSQL RPC', async () => {
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
      platformTraceId: 'trace_1', userId: 'attacker',
    }, context)
    await handler({
      action: 'updateUserRole', requestId: 'request_1', targetUserId: 'user_1',
      newRole: 'super_admin', expectedVersion: 1,
      source: 'cloudbase-runtime', callerUserId: 'attacker',
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

  it('rejects unknown actions and invalid business fields', async () => {
    const rpc = vi.fn()
    const handler = createUserRoleHandler({ rpc })

    await expect(handler({ action: 'deleteUser', userId: 'user_1' }, context)).resolves.toEqual({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    await expect(handler({ action: 'listUsers', page: 1, pageSize: 21, extra: true }, context))
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
