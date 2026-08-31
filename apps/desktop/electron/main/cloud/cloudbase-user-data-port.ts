import {
  accountDataPreferencesRecordSchema,
  chatBlockSchema,
  conversationTitleStateSchema,
  legacyImportConfirmRequestSchema,
  legacyImportResultSchema,
  opaqueCursorSchema,
  pulledMutationSchema,
  syncMutationResultSchema,
  syncMutationSchema,
  toSafeAppError,
  type AppError,
  type PulledMutation,
  type SyncMutationResult,
  type AccountDataPreferencesRecord,
  type LegacyImportResult,
} from '@autoforge/shared'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { CloudBaseFunctionPort } from '../auth/cloudbase-auth-port.js'

const syncProtocolVersionSchema = z.union([z.literal(1), z.literal(2), z.literal(3)])
const legacyProtocolVersionSchema = z.literal(1)
const identifierSchema = z.string().min(1).max(128).refine((value) => value.trim() === value)
export const maximumUserDataCallBytes = 1_048_576
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

export interface UserDataCallDiagnostic {
  action: string | undefined
  stage: 'local_validation_failed' | 'function_invocation_failed' | 'remote_error' | 'response_validation_failed'
  code: UserDataErrorCode
  bytes?: number
  conversationCount?: number
  messageCount?: number
  remoteStage?: string
}

const syncPushCallSchema = z.object({
  action: z.literal('syncPush'),
  protocolVersion: syncProtocolVersionSchema,
  deviceId: identifierSchema,
  mutations: z.array(syncMutationSchema).max(100),
}).strict()

const syncPullCallSchema = z.object({
  action: z.literal('syncPull'),
  protocolVersion: syncProtocolVersionSchema,
  deviceId: identifierSchema,
  cursor: opaqueCursorSchema.optional(),
  limit: z.number().int().positive().max(100).optional(),
}).strict()

const legacyConversationSchema = z.object({
  id: identifierSchema,
  title: z.string().trim().min(1),
  titleState: conversationTitleStateSchema,
  createdAt: z.iso.datetime({ offset: true }),
  lastActivityAt: z.iso.datetime({ offset: true }),
  metadataUpdatedAt: z.iso.datetime({ offset: true }),
  sourceUnowned: z.boolean().optional(),
}).strict()
const legacyMessageSchema = z.object({
  id: identifierSchema,
  conversationId: identifierSchema,
  role: z.enum(['user', 'assistant']),
  blocks: z.array(chatBlockSchema),
  executionId: identifierSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  sourceUnowned: z.boolean().optional(),
}).strict()
const importLegacyBatchCallSchema = legacyImportConfirmRequestSchema.extend({
  action: z.literal('importLegacyBatch'),
  protocolVersion: legacyProtocolVersionSchema,
  deviceId: identifierSchema,
  conversations: z.array(legacyConversationSchema),
  messages: z.array(legacyMessageSchema),
}).strict().superRefine((input, context) => {
  if (input.conversations.length + input.messages.length > 100) {
    context.addIssue({ code: 'custom', message: 'Legacy batch exceeds record limit' })
  }
  if (!input.includeUnowned && [...input.conversations, ...input.messages]
    .some((item) => item.sourceUnowned === true)) {
    context.addIssue({ code: 'custom', message: 'Unowned rows require confirmation' })
  }
})
const getUserDataPreferencesCallSchema = z.object({
  action: z.literal('getUserDataPreferences'),
}).strict()
const getUsageSnapshotCallSchema = z.object({
  action: z.literal('getUsageSnapshot'),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((input, context) => {
  if (Date.parse(input.startedAt) >= Date.parse(input.endedAt)) {
    context.addIssue({ code: 'custom', path: ['endedAt'], message: 'Usage period is invalid' })
  }
})

const cloudBaseUserDataCallSchema = z.discriminatedUnion('action', [
  syncPushCallSchema,
  syncPullCallSchema,
  importLegacyBatchCallSchema,
  getUserDataPreferencesCallSchema,
  getUsageSnapshotCallSchema,
])

export type CloudBaseUserDataCall = z.infer<typeof cloudBaseUserDataCallSchema>

export function serializedUserDataCallBytes(input: unknown): number {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw toSafeAppError({ code: 'INVALID_INPUT' })
  }
  if (typeof serialized !== 'string') throw toSafeAppError({ code: 'INVALID_INPUT' })
  return Buffer.byteLength(serialized, 'utf8')
}

export function userDataCallFitsWireLimit(input: unknown): boolean {
  return serializedUserDataCallBytes(input) <= maximumUserDataCallBytes
}

const syncPushDataSchema = z.object({
  results: z.array(syncMutationResultSchema).max(100),
  cursor: opaqueCursorSchema.optional(),
}).strict()

const syncPullDataSchema = z.object({
  mutations: z.array(pulledMutationSchema).max(100),
  cursor: opaqueCursorSchema.nullable(),
}).strict()

const remoteUsageDataSchema = z.object({
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).transform((value) => {
    const [whole, fractional] = value.split('.')
    const canonicalFraction = fractional?.replace(/0+$/, '')
    return canonicalFraction ? `${whole}.${canonicalFraction}` : whole!
  }),
  estimatedCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
}).strict()
export type RemoteUsageData = z.infer<typeof remoteUsageDataSchema>

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
  | { ok: true; data: SyncPushData | SyncPullData | LegacyImportResult | AccountDataPreferencesRecord | RemoteUsageData }
  | { ok: false; error: { code: UserDataErrorCode } }

const functionResponseSchema = z.object({ result: z.unknown() }).passthrough()
const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: userDataErrorCodeSchema,
    stage: z.string().regex(/^(?:shape(?:_[a-z_]{1,80})?|identifier|batch|conversation|message|consent|unowned|rpc)$/).optional(),
  }).strict(),
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
    private readonly onDiagnostic?: (diagnostic: UserDataCallDiagnostic) => void,
  ) {}

  async call(input: CloudBaseUserDataCall): Promise<UserDataFunctionResponse> {
    try {
      return await this.callValidated(input)
    } catch (error) {
      this.diagnose(input, 'local_validation_failed', toSafeAppError(error).code)
      throw error
    }
  }

  private async callValidated(input: CloudBaseUserDataCall): Promise<UserDataFunctionResponse> {
    if (!userDataCallFitsWireLimit(input)) {
      throw toSafeAppError({ code: 'INVALID_INPUT' })
    }
    if (!isRecord(input)) throw toSafeAppError({ code: 'INVALID_INPUT' })
    if (input.action === 'syncPush') {
      if (!hasStrictShape(input, ['action', 'protocolVersion', 'deviceId', 'mutations'])) {
        throw toSafeAppError({ code: 'INVALID_INPUT' })
      }
      if (input.protocolVersion !== 1 && input.protocolVersion !== 2 && input.protocolVersion !== 3) {
        throw toSafeAppError({ code: 'UPGRADE_REQUIRED' })
      }
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
      if (input.protocolVersion !== 1 && input.protocolVersion !== 2 && input.protocolVersion !== 3) {
        throw toSafeAppError({ code: 'UPGRADE_REQUIRED' })
      }
    } else if (input.action === 'importLegacyBatch') {
      if (!hasStrictShape(input, [
        'action', 'protocolVersion', 'deviceId', 'batchId', 'includeUnowned',
        'conversations', 'messages', 'cloudSyncConsent',
      ], ['unownedImportConsent'])) throw toSafeAppError({ code: 'INVALID_INPUT' })
      if (input.protocolVersion !== 1) throw toSafeAppError({ code: 'UPGRADE_REQUIRED' })
      if (!Array.isArray(input.conversations) || !Array.isArray(input.messages)) {
        throw toSafeAppError({ code: 'INVALID_INPUT' })
      }
      if (input.conversations.length + input.messages.length > 100) {
        throw toSafeAppError({ code: 'OUTBOX_LIMIT_EXCEEDED' })
      }
    } else if (input.action !== 'getUserDataPreferences' && input.action !== 'getUsageSnapshot') {
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
      const safeError = invocationError(error)
      this.diagnose(input, 'function_invocation_failed', safeError.code)
      throw safeError
    }

    const response = functionResponseSchema.safeParse(raw)
    if (!response.success) {
      const error = malformedResponse()
      this.diagnose(input, 'response_validation_failed', error.code)
      throw error
    }
    const failed = errorEnvelopeSchema.safeParse(response.data.result)
    if (failed.success) {
      this.diagnose(input, 'remote_error', failed.data.error.code, failed.data.error.stage)
      return failed.data
    }

    const dataSchema = parsedInput.data.action === 'syncPush'
      ? syncPushDataSchema
      : parsedInput.data.action === 'syncPull'
        ? syncPullDataSchema
        : parsedInput.data.action === 'importLegacyBatch'
          ? legacyImportResultSchema
          : parsedInput.data.action === 'getUserDataPreferences'
            ? accountDataPreferencesRecordSchema
            : remoteUsageDataSchema
    const succeeded = z.object({ ok: z.literal(true), data: dataSchema }).strict()
      .safeParse(response.data.result)
    if (!succeeded.success) {
      const error = malformedResponse()
      this.diagnose(input, 'response_validation_failed', error.code)
      throw error
    }
    return succeeded.data as UserDataFunctionResponse
  }

  private diagnose(
    input: unknown,
    stage: UserDataCallDiagnostic['stage'],
    code: AppError['code'],
    remoteStage?: UserDataCallDiagnostic['remoteStage'],
  ): void {
    const parsedCode = userDataErrorCodeSchema.safeParse(code)
    const diagnosticCode: UserDataErrorCode = parsedCode.success ? parsedCode.data : 'INTERNAL_ERROR'
    if (!isRecord(input)) {
      this.onDiagnostic?.({ action: undefined, stage, code: diagnosticCode })
      return
    }
    const action = typeof input.action === 'string' ? input.action : undefined
    if (action !== 'importLegacyBatch') return
    let bytes: number | undefined
    try {
      bytes = serializedUserDataCallBytes(input)
    } catch {
      // The stage and code still identify this failure without serializing user content.
    }
    this.onDiagnostic?.({
      action,
      stage,
      code: diagnosticCode,
      ...(bytes === undefined ? {} : { bytes }),
      ...(Array.isArray(input.conversations) ? { conversationCount: input.conversations.length } : {}),
      ...(Array.isArray(input.messages) ? { messageCount: input.messages.length } : {}),
      ...(remoteStage === undefined ? {} : { remoteStage }),
    })
  }
}
