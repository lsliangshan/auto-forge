import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalizeMembershipPayload,
  createMembershipHandler,
} from '../../cloudbase/membership/function/membership-handler.js'

const context = { auth: { uid: 'admin_1' } }

function summary(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user_1', planId: 'pro', planVersion: 1, state: 'active',
    effectiveStatus: 'active', grantKind: 'manual_grant', version: 1,
    termEndsAt: '2027-08-29T00:00:00.000Z',
    limits: { knowledgeBases: 20, knowledgeDocuments: 500, knowledgeFileBytes: 67_108_864 },
    cloudEligible: true, updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  }
}

describe('CloudBase membership function', () => {
  it('takes actor identity only from trusted context and forwards narrow mutation fields', async () => {
    const rpc = vi.fn().mockResolvedValue(summary())
    const keys = generateKeyPairSync('ed25519')
    const handler = createMembershipHandler({
      rpc, privateKey: keys.privateKey, keyId: 'membership-2026-02',
      now: () => Date.parse('2026-08-29T00:00:00.000Z'),
    })
    const event = {
      action: 'mutate', operation: 'grant', requestId: 'request_1', targetUserId: 'user_1',
      expectedVersion: 0, grantKind: 'manual_grant',
      termEndsAt: '2027-08-29T00:00:00.000Z', reasonCode: 'manual_payment_confirmed',
      note: '工单 1001', actorUserId: 'attacker', privateKey: 'forbidden',
    }
    await expect(handler(event, context)).resolves.toMatchObject({
      ok: true, data: { status: 'applied', membership: { userId: 'user_1' } },
    })
    expect(rpc).toHaveBeenCalledWith('autoforge_membership_mutate', {
      p_caller_user_id: 'admin_1', p_request_id: 'request_1', p_target_user_id: 'user_1',
      p_expected_version: 0, p_action: 'grant', p_grant_kind: 'manual_grant',
      p_term_ends_at: '2027-08-29T00:00:00.000Z',
      p_reason_code: 'manual_payment_confirmed', p_note: '工单 1001',
    })
  })

  it('signs canonical owner-bound Free and Pro snapshots without exposing the private key', async () => {
    const keys = generateKeyPairSync('ed25519')
    const rpc = vi.fn().mockResolvedValue(summary())
    const handler = createMembershipHandler({
      rpc, privateKey: keys.privateKey, keyId: 'membership-2026-02',
      now: () => Date.parse('2026-08-29T00:00:00.000Z'),
    })
    const response = await handler({ action: 'getCurrent' }, { auth: { uid: 'user_1' } })
    expect(response).toMatchObject({ ok: true, data: { membership: { planId: 'pro' } } })
    const envelope = response.ok ? response.data.entitlement : undefined
    expect(envelope).toEqual({ payload: expect.any(String), signature: expect.any(String) })
    const payloadBytes = Buffer.from(envelope.payload, 'base64url')
    expect(JSON.parse(payloadBytes.toString('utf8'))).toMatchObject({
      schemaVersion: 2, userId: 'user_1', membershipVersion: 1,
      effectiveStatus: 'active',
      refreshAfter: '2026-08-29T00:05:00.000Z', keyId: 'membership-2026-02',
    })
    expect(payloadBytes.toString()).toBe(canonicalizeMembershipPayload(
      JSON.parse(payloadBytes.toString('utf8')),
    ))
    expect(verify(
      null, payloadBytes, keys.publicKey, Buffer.from(envelope.signature, 'base64url'),
    )).toBe(true)
    expect(JSON.stringify(response)).not.toContain('PRIVATE KEY')
  })

  it('supports target lookup, audit pagination, and explicit correction fields', async () => {
    const keys = generateKeyPairSync('ed25519')
    const rpc = vi.fn()
      .mockResolvedValueOnce(summary())
      .mockResolvedValueOnce({
        items: [{
          id: 'event_1', targetUserId: 'user_1', actorUserId: 'admin_1', action: 'correct',
          reasonCode: 'operator_correction', previousVersion: 1, resultingVersion: 2,
          createdAt: '2026-08-29T00:00:00.000Z',
        }], page: 1, pageSize: 20, total: 1,
      })
      .mockResolvedValueOnce(summary({ planId: 'free', state: 'revoked', version: 2 }))
    const handler = createMembershipHandler({
      rpc, privateKey: keys.privateKey, keyId: 'membership-2026-02',
    })

    await expect(handler({ action: 'getTarget', targetUserId: 'user_1' }, context))
      .resolves.toMatchObject({ ok: true, data: { membership: { userId: 'user_1' } } })
    await expect(handler({
      action: 'listAudit', targetUserId: 'user_1', page: 1, pageSize: 20,
    }, context)).resolves.toMatchObject({ ok: true, data: { total: 1 } })
    await expect(handler({
      action: 'mutate', operation: 'correct', requestId: 'request_2', targetUserId: 'user_1',
      expectedVersion: 1, planId: 'free', state: 'revoked', grantKind: null,
      termEndsAt: null, reasonCode: 'operator_correction',
    }, context)).resolves.toMatchObject({ ok: true, data: { membership: { version: 2 } } })

    expect(rpc).toHaveBeenNthCalledWith(1, 'autoforge_membership_get_target', {
      p_caller_user_id: 'admin_1', p_target_user_id: 'user_1',
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'autoforge_membership_list_audit', {
      p_caller_user_id: 'admin_1', p_target_user_id: 'user_1', p_page: 1, p_page_size: 20,
    })
    expect(rpc).toHaveBeenNthCalledWith(3, 'autoforge_membership_mutate', expect.objectContaining({
      p_action: 'correct', p_plan_id: 'free', p_state: 'revoked', p_grant_kind: null,
      p_term_ends_at: null,
    }))
  })

  it('fails closed without signing material and masks unknown failures', async () => {
    expect(() => createMembershipHandler({
      rpc: vi.fn(), privateKey: undefined, keyId: 'membership-2026-02',
    })).toThrow('MEMBERSHIP_SIGNING_UNAVAILABLE')
    const keys = generateKeyPairSync('ed25519')
    const handler = createMembershipHandler({
      rpc: vi.fn().mockRejectedValue(new Error('database password leaked')),
      privateKey: keys.privateKey, keyId: 'membership-2026-02',
    })
    await expect(handler({ action: 'getCurrent' }, { auth: { uid: 'user_1' } }))
      .resolves.toEqual({ ok: false, error: { code: 'INTERNAL_ERROR' } })
  })
})
