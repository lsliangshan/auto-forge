import {
  appErrorCodeSchema,
  authorizationSnapshotSchema,
  signedKnowledgeEntitlementSnapshotSchema,
  toSafeAppError,
  userAdminListResponseSchema,
  userAdminUpdateRoleResponseSchema,
  type AuthorizationSnapshot,
  type UserAdminListRequest,
  type UserAdminListResponse,
  type UserAdminUpdateRoleRequest,
  type UserAdminUpdateRoleResponse,
} from '@autoforge/shared'
import { z } from 'zod'

export interface CloudBaseFunctionPort {
  callFunction(options: {
    name: string
    data: Record<string, unknown>
  }): Promise<unknown>
}

export interface BusinessRoleService {
  ensureMyRole(): Promise<AuthorizationSnapshot>
  listUsers(input: UserAdminListRequest): Promise<UserAdminListResponse>
  updateUserRole(input: UserAdminUpdateRoleRequest): Promise<UserAdminUpdateRoleResponse>
}

const functionResponseSchema = z.object({ result: z.unknown() }).passthrough()
const successEnvelopeSchema = z.object({ ok: z.literal(true), data: z.unknown() }).strict()
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: appErrorCodeSchema }).passthrough(),
}).strict()

const ensureRoleDataSchema = authorizationSnapshotSchema.omit({ confirmed: true }).extend({
  userId: z.string().trim().min(1),
  knowledgeEntitlement: signedKnowledgeEntitlementSnapshotSchema.nullable().optional(),
}).strict()

function parseCloudData<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw toSafeAppError({ code: 'INTERNAL_ERROR' })
  return parsed.data
}

export class CloudBaseRoleService implements BusinessRoleService {
  constructor(
    private readonly functions: CloudBaseFunctionPort,
    private readonly functionName = 'autoforge-user-roles',
  ) {}

  private async invoke(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
    let rawResponse: unknown
    try {
      rawResponse = await this.functions.callFunction({
        name: this.functionName,
        data: { action, ...input },
      })
    } catch (error) {
      const safe = toSafeAppError(error)
      throw safe.code === 'INTERNAL_ERROR'
        ? toSafeAppError({ code: 'SERVICE_UNAVAILABLE' })
        : safe
    }
    try {
      const response = functionResponseSchema.parse(rawResponse)
      const failed = errorEnvelopeSchema.safeParse(response.result)
      if (failed.success) throw toSafeAppError({ code: failed.data.error.code })
      const succeeded = successEnvelopeSchema.safeParse(response.result)
      if (!succeeded.success) throw toSafeAppError({ code: 'INTERNAL_ERROR' })
      return succeeded.data.data
    } catch (error) {
      const safe = toSafeAppError(error)
      if (safe.code !== 'INTERNAL_ERROR') throw safe
      throw toSafeAppError({ code: 'INTERNAL_ERROR' })
    }
  }

  async ensureMyRole(): Promise<AuthorizationSnapshot> {
    const data = parseCloudData(ensureRoleDataSchema, await this.invoke('ensureMyRole'))
    const capabilities = data.role === 'super_admin'
      ? [...new Set([...data.capabilities, 'manage_memberships' as const])]
      : data.capabilities
    return parseCloudData(authorizationSnapshotSchema, {
      role: data.role,
      capabilities,
      version: data.version,
      updatedAt: data.updatedAt,
      confirmed: true,
      ...(data.knowledgeEntitlement ? { knowledgeEntitlement: data.knowledgeEntitlement } : {}),
      ...(data.membershipEntitlement ? { membershipEntitlement: data.membershipEntitlement } : {}),
    })
  }

  async listUsers(input: UserAdminListRequest): Promise<UserAdminListResponse> {
    try {
      return await this.invokeUserList(input)
    } catch (error) {
      const code = toSafeAppError(error).code
      if (input.filter?.field !== 'keyword' || code !== 'INVALID_INPUT') {
        throw error
      }
      return this.listUsersWithLegacyKeyword(input)
    }
  }

  private async invokeUserList(input: UserAdminListRequest): Promise<UserAdminListResponse> {
    return parseCloudData(userAdminListResponseSchema, await this.invoke('listUsers', input))
  }

  private async listUsersWithLegacyKeyword(input: UserAdminListRequest): Promise<UserAdminListResponse> {
    const keyword = input.filter?.value ?? ''
    const pageSize = 100 as const
    const firstPage = await this.invokeUserList({ page: 1, pageSize })
    const usersById = new Map(firstPage.items.map(user => [user.userId, user]))
    const pageCount = Math.ceil(firstPage.total / pageSize)
    for (let page = 2; page <= pageCount; page += 1) {
      const result = await this.invokeUserList({ page, pageSize })
      for (const user of result.items) usersById.set(user.userId, user)
    }

    const exactContactMatches = await Promise.all((['email', 'phone'] as const).map(field => (
      this.invokeUserList({ page: 1, pageSize, filter: { field, value: keyword } })
    )))
    const exactUserIds = new Set(exactContactMatches.flatMap(result => (
      result.items.map(user => user.userId)
    )))
    const normalizedKeyword = keyword.toLocaleLowerCase()
    const matches = [...usersById.values()].filter(user => (
      exactUserIds.has(user.userId)
      || [user.username, user.displayName, user.userId, user.maskedEmail, user.maskedPhone]
        .some(value => value?.toLocaleLowerCase().includes(normalizedKeyword))
    ))
    const offset = (input.page - 1) * input.pageSize
    return {
      items: matches.slice(offset, offset + input.pageSize),
      page: input.page,
      pageSize: input.pageSize,
      total: matches.length,
    }
  }

  async updateUserRole(input: UserAdminUpdateRoleRequest): Promise<UserAdminUpdateRoleResponse> {
    return parseCloudData(userAdminUpdateRoleResponseSchema, await this.invoke('updateUserRole', input))
  }
}
