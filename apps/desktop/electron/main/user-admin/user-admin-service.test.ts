import { describe, expect, it, vi } from 'vitest'
import { toSafeAppError, type AuthSession } from '@autoforge/shared'
import { UserAdminService } from './user-admin-service.js'

const adminSession: AuthSession = {
  user: { id: 'admin_1', account: 'Admin' },
  authenticatedAt: '2026-08-21T00:00:00.000Z',
  authorization: {
    role: 'super_admin', capabilities: ['manage_users'], version: 1,
    updatedAt: '2026-08-21T00:00:00.000Z', confirmed: true,
  },
}

describe('UserAdminService', () => {
  it('rejects unconfirmed or unauthorized sessions before calling CloudBase', async () => {
    const roles = { listUsers: vi.fn(), updateUserRole: vi.fn() }
    const service = new UserAdminService({
      requireSession: vi.fn().mockResolvedValue({
        ...adminSession,
        authorization: { ...adminSession.authorization!, capabilities: [], confirmed: false },
      }),
    }, roles)

    await expect(service.list({ page: 1, pageSize: 20 })).rejects.toEqual(
      toSafeAppError({ code: 'FORBIDDEN' }),
    )
    expect(roles.listUsers).not.toHaveBeenCalled()
  })

  it('delegates strict list and update requests for a confirmed administrator', async () => {
    const listResponse = { items: [], page: 1, pageSize: 20 as const, total: 0 }
    const updateResponse = {
      userId: 'user_1', role: 'super_admin' as const, version: 2,
      updatedAt: '2026-08-21T01:00:00.000Z',
    }
    const roles = {
      listUsers: vi.fn().mockResolvedValue(listResponse),
      updateUserRole: vi.fn().mockResolvedValue(updateResponse),
    }
    const service = new UserAdminService({
      requireSession: vi.fn().mockResolvedValue(adminSession),
    }, roles)

    await expect(service.list({ page: 1, pageSize: 20 })).resolves.toEqual(listResponse)
    await expect(service.updateRole({
      requestId: 'request_1', targetUserId: 'user_1', newRole: 'super_admin', expectedVersion: 1,
    })).resolves.toEqual(updateResponse)
  })
})
