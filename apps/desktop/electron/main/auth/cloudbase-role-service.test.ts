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
      capabilities: ['manage_users'],
      version: 2,
      updatedAt: '2026-08-21T00:00:00.000Z',
      confirmed: true,
    })
    expect(callFunction).toHaveBeenCalledWith({
      name: 'autoforge-user-roles',
      data: { action: 'ensureMyRole' },
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
})
