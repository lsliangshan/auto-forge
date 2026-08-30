import {
  appErrorCodeSchema,
  membershipAuditListResponseSchema,
  membershipMutationResponseSchema,
  membershipSummarySchema,
  signedMembershipEntitlementSnapshotSchema,
  toSafeAppError,
  type AuthSession,
  type DesktopAPI,
  type MembershipSummary,
  type SignedMembershipEntitlementSnapshot,
} from '@autoforge/shared'
import { z } from 'zod'
import type { CloudBaseFunctionPort } from '../auth/cloudbase-role-service.js'

interface MembershipAuthPort {
  requireSession(): Promise<AuthSession>
}

const functionResponseSchema = z.object({ result: z.unknown() }).passthrough()
const successEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict()
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: appErrorCodeSchema }).passthrough(),
}).strict()
const currentResponseSchema = z.object({
  membership: membershipSummarySchema,
  entitlement: signedMembershipEntitlementSnapshotSchema,
}).strict()
const targetResponseSchema = z.object({ membership: membershipSummarySchema }).strict()

export interface CurrentMembershipEnvelope {
  membership: MembershipSummary
  entitlement: SignedMembershipEntitlementSnapshot
}

export type MembershipControlService = DesktopAPI['membership'] & {
  refreshCurrent(): Promise<CurrentMembershipEnvelope>
}

export class CloudBaseMembershipService implements MembershipControlService {
  constructor(
    private readonly auth: MembershipAuthPort,
    private readonly functions: CloudBaseFunctionPort,
    private readonly functionName = 'autoforge-membership',
  ) {}

  private async invoke(data: Record<string, unknown>): Promise<unknown> {
    let raw: unknown
    try {
      raw = await this.functions.callFunction({ name: this.functionName, data })
    } catch (error) {
      const safe = toSafeAppError(error)
      throw safe.code === 'INTERNAL_ERROR'
        ? toSafeAppError({ code: 'SERVICE_UNAVAILABLE' })
        : safe
    }
    const response = functionResponseSchema.safeParse(raw)
    if (!response.success) throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    const failed = errorEnvelopeSchema.safeParse(response.data.result)
    if (failed.success) throw toSafeAppError({ code: failed.data.error.code })
    const succeeded = successEnvelopeSchema.safeParse(response.data.result)
    if (!succeeded.success) throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    return succeeded.data.data
  }

  private async requireManageMemberships(): Promise<AuthSession> {
    const session = await this.auth.requireSession()
    if (session.authorization?.confirmed !== true
      || !session.authorization.capabilities.includes('manage_memberships')) {
      throw toSafeAppError({ code: 'FORBIDDEN' })
    }
    return session
  }

  async refreshCurrent(): Promise<CurrentMembershipEnvelope> {
    const session = await this.auth.requireSession()
    const parsed = currentResponseSchema.safeParse(await this.invoke({ action: 'getCurrent' }))
    if (!parsed.success || parsed.data.membership.userId !== session.user.id) {
      throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    }
    return parsed.data
  }

  async getCurrent(): Promise<MembershipSummary> {
    return (await this.refreshCurrent()).membership
  }

  async getTarget(targetUserId: string): Promise<MembershipSummary> {
    await this.requireManageMemberships()
    const parsed = targetResponseSchema.safeParse(await this.invoke({ action: 'getTarget', targetUserId }))
    if (!parsed.success || parsed.data.membership.userId !== targetUserId) {
      throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    }
    return parsed.data.membership
  }

  async mutate(input: Parameters<DesktopAPI['membership']['mutate']>[0]) {
    await this.requireManageMemberships()
    const parsed = membershipMutationResponseSchema.safeParse(await this.invoke({
      action: 'mutate', operation: input.action,
      ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'action')),
    }))
    if (!parsed.success || parsed.data.membership.userId !== input.targetUserId) {
      throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    }
    return parsed.data
  }

  async listAudit(input: Parameters<DesktopAPI['membership']['listAudit']>[0]) {
    await this.requireManageMemberships()
    const parsed = membershipAuditListResponseSchema.safeParse(await this.invoke({
      action: 'listAudit', ...input,
    }))
    if (!parsed.success) throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    return parsed.data
  }
}
