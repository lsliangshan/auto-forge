import { describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '@autoforge/shared'
import { CloudBaseMembershipService } from './cloudbase-membership-service.js'

const summary = {
  userId: 'user_1', planId: 'free', planVersion: 1, state: 'active',
  effectiveStatus: 'active', grantKind: null, version: 0, termEndsAt: null,
  limits: { knowledgeBases: 1, knowledgeDocuments: 1, knowledgeFileBytes: 67_108_864 },
  cloudEligible: false, updatedAt: '2026-08-29T00:00:00.000Z',
} as const

function session(
  capabilities: NonNullable<AuthSession['authorization']>['capabilities'] = [],
): AuthSession {
  return {
    user: { id: 'user_1', account: '+8613800000000' },
    authenticatedAt: '2026-08-29T00:00:00.000Z',
    authorization: {
      role: capabilities.length ? 'super_admin' : 'user', capabilities, version: 1,
      updatedAt: '2026-08-29T00:00:00.000Z', confirmed: true,
    },
  }
}

describe('CloudBaseMembershipService', () => {
  it('allows a user to load only their owner-bound signed current membership', async () => {
    const functions = { callFunction: vi.fn().mockResolvedValue({
      result: { ok: true, data: { membership: summary, entitlement: { payload: 'abc', signature: 'def' } } },
    }) }
    const service = new CloudBaseMembershipService({ requireSession: async () => session() }, functions)
    await expect(service.refreshCurrent()).resolves.toEqual({
      membership: summary, entitlement: { payload: 'abc', signature: 'def' },
    })
    expect(functions.callFunction).toHaveBeenCalledWith({
      name: 'autoforge-membership', data: { action: 'getCurrent' },
    })
  })

  it('requires confirmed manage_memberships and forbids self mutation in Main', async () => {
    const functions = { callFunction: vi.fn() }
    const denied = new CloudBaseMembershipService({ requireSession: async () => session() }, functions)
    await expect(denied.getTarget('user_2')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const allowed = new CloudBaseMembershipService({
      requireSession: async () => session(['manage_memberships']),
    }, functions)
    await expect(allowed.mutate({
      action: 'revoke', requestId: 'request_1', targetUserId: 'user_1', expectedVersion: 1,
      reasonCode: 'risk_revocation',
    })).rejects.toMatchObject({ code: 'SELF_MEMBERSHIP_CHANGE_FORBIDDEN' })
    expect(functions.callFunction).not.toHaveBeenCalled()
  })

  it('maps narrow admin calls and rejects malformed cloud responses', async () => {
    const functions = { callFunction: vi.fn()
      .mockResolvedValueOnce({ result: { ok: true, data: {
        membership: { ...summary, userId: 'user_2' },
      } } })
      .mockResolvedValueOnce({ result: { ok: true, data: { items: [], page: 1, pageSize: 20, total: 0 } } })
      .mockResolvedValueOnce({ result: { ok: true, data: { privateKey: 'forbidden' } } }),
    }
    const service = new CloudBaseMembershipService({
      requireSession: async () => session(['manage_memberships']),
    }, functions)
    await expect(service.getTarget('user_2')).resolves.toEqual({ ...summary, userId: 'user_2' })
    await expect(service.listAudit({ targetUserId: 'user_2', page: 1, pageSize: 20 }))
      .resolves.toEqual({ items: [], page: 1, pageSize: 20, total: 0 })
    await expect(service.getTarget('user_2')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})
