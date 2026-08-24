import {
  appErrorCodeSchema,
  opaqueCursorSchema,
  syncMutationKindSchema,
  syncMutationResultSchema,
  syncMutationSchema,
  toSafeAppError,
  type AppError,
  type AppErrorCode,
  type SyncMutation,
  type SyncMutationResult,
} from '@autoforge/shared'
import { z } from 'zod'
import type { CloudBaseFunctionPort } from '../auth/cloudbase-auth-port.js'

const protocolVersionSchema = z.literal(1)
const identifierSchema = z.string().trim().min(1).max(128)

const syncPushCallSchema = z.object({
  action: z.literal('syncPush'),
  protocolVersion: protocolVersionSchema,
  deviceId: identifierSchema,
  mutations: z.array(syncMutationSchema).max(100),
}).strict()

const syncPullCallSchema = z.object({
  action: z.literal('syncPull'),
  protocolVersion: protocolVersionSchema,
  deviceId: identifierSchema,
  cursor: opaqueCursorSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
}).strict()

const cloudBaseUserDataCallSchema = z.discriminatedUnion('action', [
  syncPushCallSchema,
  syncPullCallSchema,
])

export type CloudBaseUserDataCall = z.infer<typeof cloudBaseUserDataCallSchema>

const syncPushDataSchema = z.object({
  results: z.array(syncMutationResultSchema).max(100),
  cursor: opaqueCursorSchema.optional(),
}).strict()

const remoteMutationSchema = z.object({
  id: identifierSchema,
  kind: syncMutationKindSchema,
  entityId: identifierSchema,
  baseRevision: z.number().int().nonnegative(),
  resultRevision: z.number().int().nonnegative().nullable(),
  payload: z.unknown(),
  receivedAt: z.string().datetime(),
}).strict().superRefine((remote, context) => {
  const mutation = syncMutationSchema.safeParse({
    id: remote.id,
    kind: remote.kind,
    entityId: remote.entityId,
    baseRevision: remote.baseRevision,
    payload: remote.payload,
    occurredAt: remote.receivedAt,
  })
  if (!mutation.success) {
    context.addIssue({ code: 'custom', message: 'Invalid remote mutation' })
  }
})

const syncPullDataSchema = z.object({
  mutations: z.array(remoteMutationSchema).max(100),
  cursor: opaqueCursorSchema.nullable(),
}).strict()

export interface SyncPushData {
  results: SyncMutationResult[]
  cursor?: string
}

export interface RemoteSyncMutation {
  id: string
  kind: SyncMutation['kind']
  entityId: string
  baseRevision: number
  resultRevision: number | null
  payload: SyncMutation['payload']
  receivedAt: string
}

export interface SyncPullData {
  mutations: RemoteSyncMutation[]
  cursor: string | null
}

export type UserDataFunctionResponse =
  | { ok: true; data: SyncPushData | SyncPullData }
  | { ok: false; error: { code: AppErrorCode } }

const functionResponseSchema = z.object({ result: z.unknown() }).passthrough()
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: appErrorCodeSchema }).strict(),
}).strict()

function invocationError(error: unknown): AppError {
  if (typeof error === 'object' && error !== null) {
    const stable = appErrorCodeSchema.safeParse((error as { code?: unknown }).code)
    if (stable.success) return toSafeAppError({ code: stable.data })
    const status = (error as { statusCode?: unknown; status?: unknown }).statusCode
      ?? (error as { status?: unknown }).status
    if (typeof status === 'number') {
      if (status === 401) return toSafeAppError({ code: 'AUTH_REQUIRED' })
      if (status === 403) return toSafeAppError({ code: 'FORBIDDEN' })
      if (status >= 500) return toSafeAppError({ code: 'SERVICE_UNAVAILABLE' })
      if (status >= 400) return toSafeAppError({ code: 'INVALID_INPUT' })
    }
  }
  return toSafeAppError({ code: 'SERVICE_UNAVAILABLE' })
}

function malformedResponse(): AppError {
  return toSafeAppError({ code: 'INTERNAL_ERROR' })
}

export class CloudBaseUserDataPort {
  constructor(
    private readonly functions: CloudBaseFunctionPort,
    private readonly functionName = 'autoforge-user-data',
  ) {}

  async call(input: CloudBaseUserDataCall): Promise<UserDataFunctionResponse> {
    const parsedInput = cloudBaseUserDataCallSchema.safeParse(input)
    if (!parsedInput.success) throw toSafeAppError({ code: 'INVALID_INPUT' })

    let raw: unknown
    try {
      raw = await this.functions.callFunction({
        name: this.functionName,
        data: parsedInput.data,
      })
    } catch (error) {
      throw invocationError(error)
    }

    const response = functionResponseSchema.safeParse(raw)
    if (!response.success) throw malformedResponse()
    const failed = errorEnvelopeSchema.safeParse(response.data.result)
    if (failed.success) return failed.data

    const dataSchema = parsedInput.data.action === 'syncPush'
      ? syncPushDataSchema
      : syncPullDataSchema
    const succeeded = z.object({ ok: z.literal(true), data: dataSchema }).strict()
      .safeParse(response.data.result)
    if (!succeeded.success) throw malformedResponse()
    return succeeded.data as UserDataFunctionResponse
  }
}
