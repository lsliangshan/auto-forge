import {
  appErrorCodeSchema,
  authorizationSnapshotSchema,
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
    try {
      const response = functionResponseSchema.parse(await this.functions.callFunction({
        name: this.functionName,
        data: { action, ...input },
      }))
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
    return parseCloudData(authorizationSnapshotSchema, {
      role: data.role,
      capabilities: data.capabilities,
      version: data.version,
      updatedAt: data.updatedAt,
      confirmed: true,
    })
  }

  async listUsers(input: UserAdminListRequest): Promise<UserAdminListResponse> {
    return parseCloudData(userAdminListResponseSchema, await this.invoke('listUsers', input))
  }

  async updateUserRole(input: UserAdminUpdateRoleRequest): Promise<UserAdminUpdateRoleResponse> {
    return parseCloudData(userAdminUpdateRoleResponseSchema, await this.invoke('updateUserRole', input))
  }
}
