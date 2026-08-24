import {
  opaqueCursorSchema,
  pulledMutationSchema,
  syncMutationResultSchema,
  syncMutationSchema,
  toSafeAppError,
  type AppError,
  type PulledMutation,
  type SyncMutationResult,
} from '@autoforge/shared'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { CloudBaseFunctionPort } from '../auth/cloudbase-auth-port.js'

const protocolVersionSchema = z.literal(1)
const identifierSchema = z.string().min(1).max(128).refine((value) => value.trim() === value)
const maximumRequestBytes = 1_048_576
const userDataErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'FORBIDDEN',
  'INVALID_INPUT',
  'SYNC_CONFLICT',
  'UPGRADE_REQUIRED',
  'IMPORT_CONFIRMATION_REQUIRED',
  'OUTBOX_LIMIT_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
])
export type UserDataErrorCode = z.infer<typeof userDataErrorCodeSchema>

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

const syncPullDataSchema = z.object({
  mutations: z.array(pulledMutationSchema).max(100),
  cursor: opaqueCursorSchema.nullable(),
}).strict()

export interface SyncPushData {
  results: SyncMutationResult[]
  cursor?: string
}

export type RemoteSyncMutation = PulledMutation

export interface SyncPullData {
  mutations: RemoteSyncMutation[]
  cursor: string | null
}

export type UserDataFunctionResponse =
  | { ok: true; data: SyncPushData | SyncPullData }
  | { ok: false; error: { code: UserDataErrorCode } }

const functionResponseSchema = z.object({ result: z.unknown() }).passthrough()
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: userDataErrorCodeSchema }).strict(),
}).strict()

function invocationError(error: unknown): AppError {
  if (typeof error === 'object' && error !== null) {
    const stable = userDataErrorCodeSchema.safeParse((error as { code?: unknown }).code)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasStrictShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key))
}

export class CloudBaseUserDataPort {
  constructor(
    private readonly functions: CloudBaseFunctionPort,
    private readonly functionName = 'autoforge-user-data',
  ) {}

  async call(input: CloudBaseUserDataCall): Promise<UserDataFunctionResponse> {
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(input)
    } catch {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    if (typeof serialized !== 'string'
      || Buffer.byteLength(serialized, 'utf8') > maximumRequestBytes) {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    if (!isRecord(input)) throw toSafeAppError({ code: 'INVALID_INPUT' })
    if (input.action === 'syncPush') {
      if (!hasStrictShape(input, ['action', 'protocolVersion', 'deviceId', 'mutations'])) {
        throw toSafeAppError({ code: 'INVALID_INPUT' })
      }
      if (input.protocolVersion !== 1) throw toSafeAppError({ code: 'UPGRADE_REQUIRED' })
      if (typeof input.deviceId !== 'string'
        || input.deviceId.length === 0
        || input.deviceId.length > 128
        || input.deviceId.trim() !== input.deviceId
        || !Array.isArray(input.mutations)) {
        throw toSafeAppError({ code: 'INVALID_INPUT' })
      }
      if (input.mutations.length > 100) {
        throw toSafeAppError({ code: 'OUTBOX_LIMIT_EXCEEDED' })
      }
    } else if (input.action === 'syncPull') {
      if (!hasStrictShape(
        input,
        ['action', 'protocolVersion', 'deviceId'],
        ['cursor', 'limit'],
      )) throw toSafeAppError({ code: 'INVALID_INPUT' })
      if (input.protocolVersion !== 1) throw toSafeAppError({ code: 'UPGRADE_REQUIRED' })
    } else {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    const parsedInput = cloudBaseUserDataCallSchema.safeParse(input)
    if (!parsedInput.success || !isDeepStrictEqual(parsedInput.data, input)) {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }

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
