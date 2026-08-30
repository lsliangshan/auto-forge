import { describe, expect, it, vi } from 'vitest'
import { CloudBaseRoleService } from './cloudbase-role-service.js'

describe('CloudBaseRoleService', () => {
  it('parses a confirmed authorization snapshot from ensureMyRole', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: {
          userId: 'uid_1',
          role: 'super_admin',
          capabilities: ['manage_users'],
          version: 2,
          updatedAt: '2026-08-21T00:00:00.000Z',
        },
      },
    })
    const service = new CloudBaseRoleService({ callFunction })

    await expect(service.ensureMyRole()).resolves.toEqual({
      role: 'super_admin',
      capabilities: ['manage_users', 'manage_memberships'],
      version: 2,
      updatedAt: '2026-08-21T00:00:00.000Z',
      confirmed: true,
    })
    expect(callFunction).toHaveBeenCalledWith({
      name: 'autoforge-user-roles',
      data: { action: 'ensureMyRole' },
    })
  })

  it('preserves only a strict opaque signed knowledge entitlement from ensureMyRole', async () => {
    const callFunction = vi.fn().mockResolvedValue({
      result: {
        ok: true,
        data: {
          userId: 'uid_1', role: 'user', capabilities: [], version: 3,
          updatedAt: '2026-08-28T00:00:00.000Z',
          knowledgeEntitlement: { payload: 'eA', signature: 'eA' },
        },
      },
    })
    const service = new CloudBaseRoleService({ callFunction })
    await expect(service.ensureMyRole()).resolves.toMatchObject({
      confirmed: true,
      knowledgeEntitlement: { payload: 'eA', signature: 'eA' },
    })

    callFunction.mockResolvedValueOnce({
      result: {
        ok: true,
        data: {
          userId: 'uid_1', role: 'user', capabilities: [], version: 3,
          updatedAt: '2026-08-28T00:00:00.000Z',
          knowledgeEntitlement: { payload: 'eA', signature: 'eA', privateKey: 'forbidden' },
        },
      },
    })
    await expect(service.ensureMyRole()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('maps a nullable cloud entitlement to an omitted free authorization field', async () => {
    const service = new CloudBaseRoleService({
      callFunction: vi.fn().mockResolvedValue({
        result: { ok: true, data: {
          userId: 'uid_1', role: 'user', capabilities: [], version: 0,
          updatedAt: '2026-08-28T00:00:00.000Z', knowledgeEntitlement: null,
        } },
      }),
    })
    await expect(service.ensureMyRole()).resolves.toEqual({
      role: 'user', capabilities: [], version: 0,
      updatedAt: '2026-08-28T00:00:00.000Z', confirmed: true,
    })
  })

  it.each([
    'AUTH_REQUIRED',
    'FORBIDDEN',
    'USER_NOT_FOUND',
    'ROLE_CONFLICT',
    'SELF_ROLE_CHANGE_FORBIDDEN',
    'LAST_SUPER_ADMIN',
    'REQUEST_ID_CONFLICT',
    'SERVICE_UNAVAILABLE',
  ] as const)('maps the stable %s cloud error', async (code) => {
    const service = new CloudBaseRoleService({
      callFunction: vi.fn().mockResolvedValue({ result: { ok: false, error: { code } } }),
    })
    await expect(service.ensureMyRole()).rejects.toMatchObject({ code })
  })

  it('rejects malformed successful responses as an internal error', async () => {
    const service = new CloudBaseRoleService({
      callFunction: vi.fn().mockResolvedValue({ result: { ok: true, data: { role: 'Super Admin' } } }),
    })
    await expect(service.ensureMyRole()).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('maps CloudBase invocation failures to service unavailable', async () => {
    const service = new CloudBaseRoleService({
      callFunction: vi.fn().mockRejectedValue(new Error('network details')),
    })
    await expect(service.ensureMyRole()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('falls back to legacy listUsers pages when the deployed function rejects keyword filters', async () => {
    const users = [
      {
        userId: '2090350246298132480', username: 'afphone_7213252235', displayName: null,
        maskedEmail: null, maskedPhone: '+86****2722', status: 'active', role: 'super_admin',
        roleVersion: 1, createdAt: '2026-08-20T08:08:30.000Z',
      },
      {
        userId: '2090348177264742400', username: 'afsmoke_7212763557', displayName: null,
        maskedEmail: 'a***@126.com', maskedPhone: null, status: 'active', role: 'user',
        roleVersion: 0, createdAt: '2026-08-20T08:00:16.000Z',
      },
      {
        userId: '2089908515857502208', username: 'administrator', displayName: 'Administrator',
        maskedEmail: null, maskedPhone: null, status: 'active', role: 'user',
        roleVersion: 0, createdAt: '2026-08-19T02:53:13.000Z',
      },
    ] as const
    const callFunction = vi.fn().mockImplementation(({ data }) => {
      if (data.filter?.field === 'keyword') {
        return Promise.resolve({ result: { ok: false, error: { code: 'INVALID_INPUT' } } })
      }
      if (data.filter?.field === 'email' || data.filter?.field === 'phone') {
        return Promise.resolve({
          result: { ok: true, data: { items: [], page: 1, pageSize: 100, total: 0 } },
        })
      }
      return Promise.resolve({
        result: { ok: true, data: { items: users, page: 1, pageSize: 100, total: users.length } },
      })
    })
    const service = new CloudBaseRoleService({ callFunction })

    await expect(service.listUsers({
      page: 1, pageSize: 20, filter: { field: 'keyword', value: '22' },
    })).resolves.toEqual({
      items: [users[0], users[2]], page: 1, pageSize: 20, total: 2,
    })
    expect(callFunction).toHaveBeenCalledWith({
      name: 'autoforge-user-roles',
      data: { action: 'listUsers', page: 1, pageSize: 100 },
    })
  })
})
