import { describe, expect, it } from 'vitest'
import {
  appErrorCodeSchema,
  accountDataPreferencesSchema,
  accountDataPreferencesRecordSchema,
  appSettingsSchema,
  approvalDecisionSchema,
  authCredentialsSchema,
  authOtpRequestSchema,
  authOtpVerificationSchema,
  browserActionAuditEntrySchema,
  chatFileSupport,
  authSessionSchema,
  authUserSchema,
  authorizationSnapshotSchema,
  chatBlockSchema,
  conversionBlockSchema,
  conversionExecutionViewSchema,
  chatEventSchema,
  chatSendInputSchema,
  byokUsageEventSchema,
  conversationPageSchema,
  conversationSummarySchema,
  executionEventSchema,
  generationOptionsSchema,
  ipcRequestSchemas,
  ipcResponseSchemas,
  ipcChannels,
  legacyImportConfirmRequestSchema,
  legacyImportRequestSchema,
  legacyImportResultSchema,
  legacyImportPreviewSchema,
  listConversationsRequestSchema,
  listMessagesRequestSchema,
  logoutRequestSchema,
  logoutResultSchema,
  retryConversationSyncRequestSchema,
  listProviderModelsRequestSchema,
  messagePageSchema,
  mediaAssetSchema,
  mediaBlockSchema,
  mediaGenerationBlockSchema,
  modelInfoSchema,
  normalizeProxySettings,
  parseProxyBypassText,
  permissionGrantSchema,
  privacyConsentSchema,
  remoteUsageSnapshotSchema,
  providerUsageModalitySchema,
  providerCredentialStatusSchema,
  proxySettingsSchema,
  pulledMutationSchema,
  sanitizeOpaqueWorkflowArgs,
  toSafeAppError,
  tokenUsageSnapshotSchema,
  syncMutationResultSchema,
  syncMutationSchema,
  userAdminListRequestSchema,
  userAdminListResponseSchema,
  userAdminUpdateRoleRequestSchema,
  userProfileSchema,
  userProfileUpdateSchema,
  workflowDetailSchema,
  workflowPermissionSchema,
  workerMessageSchema,
} from './index'

describe('cross-process contracts', () => {
  it('accepts only payload-free conversion chat blocks', () => {
    const block = {
      type: 'conversion' as const, blockId: 'conversion_block_1', executionId: 'execution_1', state: 'terminal' as const,
    }
    expect(conversionBlockSchema.parse(block)).toEqual(block)
    expect(chatBlockSchema.parse(block)).toEqual(block)
    for (const forbidden of ['bytes', 'path', 'sha256', 'artifactId', 'jobId', 'metadata', 'managedPath']) {
      expect(chatBlockSchema.safeParse({ ...block, [forbidden]: 'private-value' }).success).toBe(false)
    }
  })

  it('keeps conversion block updates and local availability strict', () => {
    const block = { type: 'conversion' as const, blockId: 'conversion_1', executionId: 'execution_1', state: 'active' as const }
    expect(chatEventSchema.parse({ type: 'block_update', conversationId: 'conversation_1', messageId: 'message_1', blockId: 'conversion_1', block })).toMatchObject({ block })
    expect(conversionExecutionViewSchema.parse({ availability: 'unavailable', jobs: [] })).toEqual({ availability: 'unavailable', jobs: [] })
    expect(conversionExecutionViewSchema.safeParse({ availability: 'unavailable', jobs: [{}] }).success).toBe(false)
    expect(chatEventSchema.safeParse({ type: 'block_update', conversationId: 'conversation_1', messageId: 'message_1', blockId: 'conversion_1', block: { ...block, jobId: 'private' } }).success).toBe(false)
  })

  it('exposes stable, safe conversion errors', () => {
    const conversionErrorCodes = [
      'CONVERSION_FORMAT_UNSUPPORTED',
      'CONVERSION_COMPONENT_UNAVAILABLE',
      'CONVERSION_INPUT_INVALID',
      'CONVERSION_OUTPUT_TOO_LARGE',
      'CONVERSION_TIMEOUT',
      'CONVERSION_CANCELLED',
      'CONVERSION_INTERRUPTED',
    ] as const

    for (const code of conversionErrorCodes) {
      expect(appErrorCodeSchema.parse(code)).toBe(code)
      expect(toSafeAppError({ code, message: 'sensitive conversion detail' })).toMatchObject({ code })
      expect(toSafeAppError({ code, message: 'sensitive conversion detail' }).message)
        .not.toBe('sensitive conversion detail')
    }
  })

  it('keeps conversion event subscription as a payload-free typed handshake', () => {
    for (const channel of [ipcChannels.conversionSubscribe, ipcChannels.conversionUnsubscribe]) {
      expect(ipcRequestSchemas[channel].parse(undefined)).toBeUndefined()
      expect(ipcRequestSchemas[channel].safeParse({ ownerUserId: 'forged' }).success).toBe(false)
      expect(ipcResponseSchemas[channel].parse(undefined)).toBeUndefined()
    }
  })

  it('requires an explicit typed discard confirmation for logout', () => {
    expect(logoutRequestSchema.parse(undefined)).toBeUndefined()
    expect(logoutRequestSchema.parse({ discardPending: true })).toEqual({ discardPending: true })
    expect(logoutRequestSchema.parse({ preservePending: true })).toEqual({ preservePending: true })
    expect(logoutRequestSchema.safeParse({ discardPending: false }).success).toBe(false)
    expect(logoutRequestSchema.safeParse({ discardPending: true, userId: 'forged' }).success).toBe(false)
    expect(logoutResultSchema.parse({ status: 'logged_out' })).toEqual({ status: 'logged_out' })
    expect(logoutResultSchema.parse({ status: 'pending_sync', pendingCount: 3 }))
      .toEqual({ status: 'pending_sync', pendingCount: 3 })
    expect(logoutResultSchema.parse({ status: 'sync_timeout' }))
      .toEqual({ status: 'sync_timeout' })
  })

  it('requires strict opaque cursor requests and paged chat responses', () => {
    const cursor = 'opaque-cursor-0001'
    expect(listConversationsRequestSchema.parse({ limit: 50 })).toEqual({ limit: 50 })
    expect(listConversationsRequestSchema.parse({ limit: 50, cursor }))
      .toEqual({ limit: 50, cursor })
    expect(listMessagesRequestSchema.parse({ conversationId: 'conv_1', limit: 100 }))
      .toEqual({ conversationId: 'conv_1', limit: 100 })
    expect(listMessagesRequestSchema.parse({ conversationId: 'conv_1', limit: 100, cursor }))
      .toEqual({ conversationId: 'conv_1', limit: 100, cursor })
    expect(listConversationsRequestSchema.safeParse({ limit: 50, userId: 'forged' }).success).toBe(false)
    expect(listMessagesRequestSchema.safeParse({ conversationId: 'conv_1', limit: 100, cursor: 'short' }).success)
      .toBe(false)
    expect(retryConversationSyncRequestSchema.parse({ conversationId: 'conv_1' }))
      .toEqual({ conversationId: 'conv_1' })
    for (const forged of [
      { conversationId: 'conv_1', userId: 'forged' },
      { conversationId: 'conv_1', mutationId: 'mutation_1' },
      { conversationId: 'conv_1', force: true },
      { conversationId: 'conv_1', error: { code: 'SYNC_CONFLICT' } },
    ]) expect(retryConversationSyncRequestSchema.safeParse(forged).success).toBe(false)

    const summary = {
      id: 'conv_1',
      title: '会话',
      titleState: 'user_named' as const,
      revision: 2,
      syncState: 'synced' as const,
      createdAt: '2026-08-24T00:00:00.000Z',
      lastActivityAt: '2026-08-24T00:01:00.000Z',
      metadataUpdatedAt: '2026-08-24T00:02:00.000Z',
    }
    expect(conversationSummarySchema.parse(summary)).toEqual(summary)
    expect(conversationSummarySchema.parse({
      ...summary, syncWarningSince: '2026-08-23T00:00:00.000Z',
    })).toMatchObject({ syncWarningSince: '2026-08-23T00:00:00.000Z' })
    expect(conversationPageSchema.parse({ items: [summary], nextCursor: cursor }))
      .toEqual({ items: [summary], nextCursor: cursor })
    expect(conversationPageSchema.parse({
      items: [summary], syncWarningSince: '2026-08-23T00:00:00.000Z',
    })).toMatchObject({ syncWarningSince: '2026-08-23T00:00:00.000Z' })
    expect.soft(conversationPageSchema.safeParse({
      items: Array.from({ length: 51 }, (_, index) => ({ ...summary, id: `conv_${index}` })),
    }).success).toBe(false)
    expect(ipcRequestSchemas[ipcChannels.chatListConversations].parse({ limit: 50 }))
      .toEqual({ limit: 50 })
    expect(ipcResponseSchemas[ipcChannels.chatListConversations].parse({ items: [summary] }))
      .toEqual({ items: [summary] })
    const message = {
      id: 'message_1',
      conversationId: 'conv_1',
      role: 'user' as const,
      blocks: [],
      createdAt: '2026-08-24T00:00:30.000Z',
    }
    expect(messagePageSchema.parse({ items: [message], previousCursor: cursor }))
      .toEqual({ items: [message], previousCursor: cursor })
    expect.soft(messagePageSchema.safeParse({
      items: Array.from({ length: 101 }, (_, index) => ({ ...message, id: `message_${index}` })),
    }).success).toBe(false)
    expect(ipcResponseSchemas[ipcChannels.chatListMessages].parse({ items: [message] }))
      .toEqual({ items: [message] })
    expect(ipcRequestSchemas[ipcChannels.chatRetrySync].parse({ conversationId: 'conv_1' }))
      .toEqual({ conversationId: 'conv_1' })
    expect(ipcRequestSchemas[ipcChannels.chatRetrySync].parse({})).toEqual({})
    expect(ipcResponseSchemas[ipcChannels.chatRetrySync].parse(undefined)).toBeUndefined()
  })

  it('enforces strict per-kind sync mutation payloads', () => {
    const mutationBase = {
      id: 'mut_1',
      entityId: 'conv_1',
      baseRevision: 0,
      occurredAt: '2026-08-24T00:00:00.000Z',
    }
    const conversationCreate = {
      ...mutationBase,
      kind: 'conversation.create' as const,
      payload: {
        title: '新会话',
        titleState: 'pending' as const,
        createdAt: '2026-08-24T00:00:00.000Z',
        lastActivityAt: '2026-08-24T00:00:00.000Z',
        metadataUpdatedAt: '2026-08-24T00:00:00.000Z',
      },
    }
    expect(syncMutationSchema.parse(conversationCreate)).toEqual(conversationCreate)
    expect(syncMutationSchema.safeParse({ ...conversationCreate, userId: 'forged' }).success).toBe(false)
    expect(syncMutationSchema.safeParse({ ...conversationCreate, ownerUserId: 'forged' }).success).toBe(false)
    expect(syncMutationSchema.safeParse({ ...conversationCreate, uid: 'forged' }).success).toBe(false)
    expect(syncMutationSchema.safeParse({
      ...conversationCreate,
      payload: { ...conversationCreate.payload, ownerUserId: 'forged' },
    }).success).toBe(false)
    expect(syncMutationSchema.safeParse({
      ...conversationCreate,
      payload: { ...conversationCreate.payload, clientSecret: 'secret' },
    }).success).toBe(false)

    const messageAppend = {
      ...mutationBase,
      kind: 'message.append' as const,
      entityId: 'message_1',
      payload: {
        id: 'message_1',
        conversationId: 'conv_1',
        role: 'user' as const,
        blocks: [],
        createdAt: '2026-08-24T00:00:30.000Z',
      },
    }
    expect(syncMutationSchema.parse(messageAppend)).toEqual(messageAppend)
    expect(syncMutationSchema.safeParse({
      ...messageAppend, payload: { ...messageAppend.payload, userId: 'forged' },
    }).success).toBe(false)

    const conversationMutations = [
      {
        ...mutationBase,
        kind: 'conversation.rename' as const,
        payload: {
          title: '手动命名',
          titleState: 'user_named' as const,
          metadataUpdatedAt: '2026-08-24T00:01:00.000Z',
        },
      },
      { ...mutationBase, kind: 'conversation.delete' as const, payload: {} },
      { ...mutationBase, kind: 'conversation.restore' as const, payload: {} },
    ]
    for (const conversationMutation of conversationMutations) {
      expect(syncMutationSchema.parse(conversationMutation)).toEqual(conversationMutation)
      expect(syncMutationSchema.safeParse({
        ...conversationMutation,
        payload: { ...conversationMutation.payload, ownerUserId: 'forged' },
      }).success).toBe(false)
    }

    const generationPreferences = {
      outputType: 'image' as const,
      models: { image: 'openrouter/image-model' },
      generation: {
        image: { count: 1 as const, resolution: '1K', aspectRatio: 'auto', format: 'png' },
        audio: { format: 'mp3' },
        video: {
          durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false,
        },
      },
    }
    const conversationPreferences = {
      ...mutationBase,
      kind: 'conversation.preferences' as const,
      payload: {
        preferences: generationPreferences,
        metadataUpdatedAt: '2026-08-24T00:02:00.000Z',
      },
    }
    expect(syncMutationSchema.parse(conversationPreferences)).toEqual(conversationPreferences)
    expect(syncMutationSchema.safeParse({
      ...conversationPreferences,
      payload: {
        ...conversationPreferences.payload,
        preferences: { ...generationPreferences, ownerUserId: 'forged' },
      },
    }).success).toBe(false)
    const pulledConversationPreferences = {
      id: conversationPreferences.id,
      kind: conversationPreferences.kind,
      entityId: conversationPreferences.entityId,
      baseRevision: conversationPreferences.baseRevision,
      resultRevision: 1,
      payload: conversationPreferences.payload,
      receivedAt: conversationPreferences.occurredAt,
    }
    expect(pulledMutationSchema.parse(pulledConversationPreferences))
      .toEqual(pulledConversationPreferences)

    const cloudSyncConsent = {
      purpose: 'cloud_sync' as const,
      documentVersion: 'privacy-2026-08',
      consentedAt: '2026-08-24T00:00:00.000Z',
      clientVersion: '2.0.0',
    }
    const unownedImportConsent = {
      ...cloudSyncConsent,
      purpose: 'legacy_unowned_import' as const,
      documentVersion: 'legacy-import-2026-08',
    }
    const privacyConsentMutation = {
      ...mutationBase,
      kind: 'privacy.consent' as const,
      entityId: 'privacy-2026-08',
      payload: cloudSyncConsent,
    }
    expect(syncMutationSchema.parse(privacyConsentMutation)).toEqual(privacyConsentMutation)
    const legacyImportMutation = {
      ...mutationBase,
      kind: 'legacy.import' as const,
      entityId: 'batch_1',
      payload: {
        batchId: 'batch_1', includeUnowned: true, cloudSyncConsent, unownedImportConsent,
      },
    }
    expect(syncMutationSchema.parse(legacyImportMutation)).toEqual(legacyImportMutation)
    expect(syncMutationSchema.safeParse({
      ...mutationBase,
      kind: 'legacy.import',
      entityId: 'batch_1',
      payload: { batchId: 'batch_1', includeUnowned: true, cloudSyncConsent },
    }).success).toBe(false)

    expect(syncMutationSchema.parse({
      ...mutationBase,
      kind: 'preferences.update',
      entityId: 'preferences',
      payload: { timezone: 'Asia/Shanghai', displayCurrency: 'CNY' },
    })).toMatchObject({ kind: 'preferences.update' })
    expect(syncMutationSchema.safeParse({
      ...mutationBase,
      kind: 'preferences.update',
      entityId: 'preferences',
      payload: { timezone: 'Asia/Shanghai', displayCurrency: 'EUR' },
    }).success).toBe(false)

    const usagePayload = {
      id: 'usage_1',
      operationId: 'operation_1',
      purpose: 'chat_reply',
      credentialOwner: 'user' as const,
      billable: false as const,
      provider: 'openrouter' as const,
      model: 'openai/gpt-5',
      modality: 'text' as const,
      costStatus: 'estimated' as const,
      inputTokens: 12,
      outputTokens: 4,
      estimatedCostUsd: '0.0012',
      occurredAt: '2026-08-24T00:00:00.000Z',
    }
    const usageMutation = {
      ...mutationBase, kind: 'usage.record' as const, entityId: 'usage_1', payload: usagePayload,
    }
    expect(syncMutationSchema.parse(usageMutation)).toEqual(usageMutation)
    for (const invalidUsage of [
      { ...usagePayload, credentialOwner: 'platform' },
      { ...usagePayload, billable: true },
      { ...usagePayload, costStatus: 'reported' },
    ]) {
      expect(syncMutationSchema.safeParse({
        ...mutationBase, kind: 'usage.record', entityId: 'usage_1', payload: invalidUsage,
      }).success).toBe(false)
    }

    for (const mismatch of [
      { ...messageAppend, entityId: 'different_message' },
      { ...legacyImportMutation, entityId: 'different_batch' },
      { ...privacyConsentMutation, entityId: 'different_document' },
      { ...usageMutation, entityId: 'different_usage' },
    ]) {
      const result = syncMutationSchema.safeParse(mismatch)
      expect.soft(result.success).toBe(false)
      if (result.success) continue
      expect.soft(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'custom',
          path: ['entityId'],
          message: 'Mutation entity identity does not match its payload.',
        }),
      ]))
      expect.soft(JSON.stringify(result.error.issues)).not.toContain(mismatch.entityId)
    }

    expect(syncMutationResultSchema.parse({ id: 'mut_1', status: 'applied', revision: 1 }))
      .toEqual({ id: 'mut_1', status: 'applied', revision: 1 })
    expect(syncMutationResultSchema.parse({ id: 'mut_1', status: 'duplicate', revision: 1 }))
      .toEqual({ id: 'mut_1', status: 'duplicate', revision: 1 })
    expect(syncMutationResultSchema.parse({
      id: 'mut_1', status: 'conflict', errorCode: 'SYNC_CONFLICT',
    })).toEqual({ id: 'mut_1', status: 'conflict', errorCode: 'SYNC_CONFLICT' })
    expect(syncMutationResultSchema.parse({
      id: 'mut_1', status: 'rejected', errorCode: 'INVALID_INPUT',
    })).toEqual({ id: 'mut_1', status: 'rejected', errorCode: 'INVALID_INPUT' })
    for (const invalidResult of [
      { id: 'mut_1', status: 'applied' },
      { id: 'mut_1', status: 'duplicate' },
      { id: 'mut_1', status: 'conflict', errorCode: 'SYNC_CONFLICT', revision: 1 },
      { id: 'mut_1', status: 'conflict' },
      { id: 'mut_1', status: 'rejected', errorCode: 'INVALID_INPUT', revision: 1 },
      { id: 'mut_1', status: 'rejected' },
    ]) {
      expect(syncMutationResultSchema.safeParse(invalidResult).success).toBe(false)
    }
    expect(syncMutationResultSchema.safeParse({ id: 'mut_1', status: 'unknown' }).success).toBe(false)
  })

  it('separates reduced pulled legacy receipts from strict push mutations', () => {
    const receipt = {
      id: 'legacy_receipt_1',
      kind: 'legacy.import' as const,
      entityId: 'legacy_batch_1',
      baseRevision: 0,
      resultRevision: 0,
      payload: { batchId: 'legacy_batch_1', includeUnowned: true },
      receivedAt: '2026-08-24T00:00:00.000Z',
    }

    expect(pulledMutationSchema.parse(receipt)).toEqual(receipt)
    expect(syncMutationSchema.safeParse({
      id: receipt.id,
      kind: receipt.kind,
      entityId: receipt.entityId,
      baseRevision: receipt.baseRevision,
      payload: receipt.payload,
      occurredAt: receipt.receivedAt,
    }).success).toBe(false)
    expect(pulledMutationSchema.safeParse({
      ...receipt,
      payload: { ...receipt.payload, clientSecret: 'secret' },
    }).success).toBe(false)
    expect(pulledMutationSchema.safeParse({
      ...receipt,
      entityId: 'different_batch',
    }).success).toBe(false)
  })

  it('accepts only strict server-authored compacted conversation receipts', () => {
    const compactedMessage = {
      id: 'message_mutation_1',
      kind: 'message.append' as const,
      entityId: 'message_1',
      conversationId: 'conversation_1',
      baseRevision: 1,
      resultRevision: 2,
      compacted: true as const,
      receivedAt: '2026-08-24T00:00:00.000Z',
    }
    const compactedDelete = {
      id: 'delete_mutation_1',
      kind: 'conversation.delete' as const,
      entityId: 'conversation_1',
      baseRevision: 2,
      resultRevision: 3,
      compacted: true as const,
      receivedAt: '2026-08-24T00:00:01.000Z',
    }
    const compactedPreferences = {
      ...compactedDelete,
      id: 'preferences_mutation_1',
      kind: 'conversation.preferences' as const,
    }

    expect(pulledMutationSchema.parse(compactedMessage)).toEqual(compactedMessage)
    expect(pulledMutationSchema.parse(compactedDelete)).toEqual(compactedDelete)
    expect(pulledMutationSchema.parse(compactedPreferences)).toEqual(compactedPreferences)
    expect(syncMutationSchema.safeParse(compactedMessage).success).toBe(false)
    for (const invalid of [
      { ...compactedMessage, payload: { blocks: [{ type: 'text', text: 'secret' }] } },
      { ...compactedMessage, conversationId: undefined },
      { ...compactedDelete, conversationId: 'conversation_1' },
      { ...compactedDelete, secret: 'not allowed' },
      { ...compactedPreferences, payload: { preferences: { outputType: 'image' } } },
      { ...compactedDelete, kind: 'usage.record' },
    ]) {
      expect(pulledMutationSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('matches Task 3 token-aware workflow proposal arg sanitization', () => {
    expect(sanitizeOpaqueWorkflowArgs({
      query: 'status:open',
      fluid: 'hydraulic',
      liquid: 'water',
      sql: 'select private',
      ServiceKey: 'service-private',
      rootPath: '/Users/private/project',
      nested: {
        Authorization: 'auth-private',
        authorizationHeader: 'header-private',
        cookieValue: 'cookie-private',
        uidValue: 'uid-private',
        filePathValue: 'file-private',
        callerUserId: 'user-private',
        access_token: 'token-private',
        passwordValue: 'password-private',
        promptText: 'prompt-private',
        response_body: 'response-private',
        imageBase64: 'base64-private',
        credentialOwner: 'owner-private',
      },
    })).toEqual({
      query: 'status:open',
      fluid: 'hydraulic',
      liquid: 'water',
      sql: '[REDACTED]',
      ServiceKey: '[REDACTED]',
      rootPath: '[REDACTED]',
      nested: {
        Authorization: '[REDACTED]',
        authorizationHeader: '[REDACTED]',
        cookieValue: '[REDACTED]',
        uidValue: '[REDACTED]',
        filePathValue: '[REDACTED]',
        callerUserId: '[REDACTED]',
        access_token: '[REDACTED]',
        passwordValue: '[REDACTED]',
        promptText: '[REDACTED]',
        response_body: '[REDACTED]',
        imageBase64: '[REDACTED]',
        credentialOwner: '[REDACTED]',
      },
    })
    expect(sanitizeOpaqueWorkflowArgs(['plain', { query: 'kept', token: 'hidden' }]))
      .toEqual(['plain', { query: 'kept', token: '[REDACTED]' }])
  })

  it('keeps cloud-sync and unowned legacy import consent distinct', () => {
    const cloudSyncConsent = {
      purpose: 'cloud_sync' as const,
      documentVersion: 'privacy-2026-08',
      consentedAt: '2026-08-24T00:00:00.000Z',
      clientVersion: '2.0.0',
    }
    const unownedImportConsent = {
      ...cloudSyncConsent,
      purpose: 'legacy_unowned_import' as const,
      documentVersion: 'legacy-import-2026-08',
    }
    expect(legacyImportPreviewSchema.parse({
      ownedCount: 4,
      unownedCount: 2,
      requiresUnownedConfirmation: true,
    })).toEqual({ ownedCount: 4, unownedCount: 2, requiresUnownedConfirmation: true })
    expect(legacyImportPreviewSchema.safeParse({
      ownedCount: 4,
      unownedCount: 2,
      requiresUnownedConfirmation: false,
    }).success).toBe(false)
    expect(privacyConsentSchema.parse(cloudSyncConsent)).toEqual(cloudSyncConsent)
    expect(legacyImportConfirmRequestSchema.parse({
      batchId: 'batch_1',
      includeUnowned: true,
      cloudSyncConsent,
      unownedImportConsent,
    })).toMatchObject({ batchId: 'batch_1', includeUnowned: true })
    expect(legacyImportConfirmRequestSchema.safeParse({
      batchId: 'batch_1', includeUnowned: true, cloudSyncConsent,
    }).success).toBe(false)
    expect(legacyImportConfirmRequestSchema.safeParse({
      batchId: 'batch_1', includeUnowned: true,
      cloudSyncConsent: unownedImportConsent,
      unownedImportConsent: cloudSyncConsent,
    }).success).toBe(false)
    expect(legacyImportConfirmRequestSchema.safeParse({
      batchId: 'batch_1', includeUnowned: false, cloudSyncConsent, unownedImportConsent,
    }).success).toBe(false)
    expect(legacyImportRequestSchema.parse({
      includeUnowned: false, cloudSyncConsent,
    })).toEqual({ includeUnowned: false, cloudSyncConsent })
    expect(legacyImportRequestSchema.safeParse({
      batchId: 'renderer-controlled', includeUnowned: false, cloudSyncConsent,
    }).success).toBe(false)
  })

  it('defines strict account preferences and safe BYOK usage events', () => {
    expect(accountDataPreferencesSchema.parse({})).toEqual({
      timezone: 'Asia/Shanghai',
      displayCurrency: 'CNY',
    })
    expect(accountDataPreferencesSchema.parse({ timezone: 'America/New_York', displayCurrency: 'USD' }))
      .toEqual({ timezone: 'America/New_York', displayCurrency: 'USD' })
    expect(accountDataPreferencesSchema.safeParse({ timezone: 'UTC', displayCurrency: 'EUR' }).success).toBe(false)

    const usage = {
      id: 'usage_1',
      operationId: 'operation_1',
      purpose: 'chat_reply',
      credentialOwner: 'user' as const,
      billable: false as const,
      provider: 'openrouter' as const,
      model: 'openai/gpt-5',
      modality: 'text' as const,
      costStatus: 'estimated' as const,
      inputTokens: 12,
      outputTokens: 4,
      estimatedCostUsd: '0.0012',
      occurredAt: '2026-08-24T00:00:00.000Z',
    }
    expect(providerUsageModalitySchema.parse('video')).toBe('video')
    expect(byokUsageEventSchema.parse(usage)).toEqual(usage)
    const unavailableUsage = { ...usage, costStatus: 'unavailable' as const }
    Reflect.deleteProperty(unavailableUsage, 'estimatedCostUsd')
    expect(byokUsageEventSchema.parse(unavailableUsage)).toMatchObject({ costStatus: 'unavailable' })
    expect(byokUsageEventSchema.safeParse({ ...usage, estimatedCostUsd: undefined }).success).toBe(false)
    expect(byokUsageEventSchema.safeParse({
      ...usage, costStatus: 'unavailable', estimatedCostUsd: '0.0012',
    }).success).toBe(false)
    expect(byokUsageEventSchema.safeParse({ ...usage, credentialOwner: 'platform' }).success).toBe(false)
    expect(byokUsageEventSchema.safeParse({ ...usage, billable: true }).success).toBe(false)
    expect(byokUsageEventSchema.safeParse({ ...usage, costStatus: 'reported' }).success).toBe(false)
    expect(byokUsageEventSchema.safeParse({ ...usage, displayCurrency: 'CNY' }).success).toBe(false)
    expect(byokUsageEventSchema.safeParse({ ...usage, apiKey: 'secret' }).success).toBe(false)
    expect(byokUsageEventSchema.safeParse({ ...usage, apiKeyFingerprint: 'fingerprint' }).success).toBe(false)
  })

  it('defines strict owner-free public legacy, preference, and remote usage responses', () => {
    expect(legacyImportResultSchema.parse({
      batchId: 'batch_1-0', status: 'applied', importedConversations: 2, importedMessages: 4,
    })).toEqual({
      batchId: 'batch_1-0', status: 'applied', importedConversations: 2, importedMessages: 4,
    })
    expect(accountDataPreferencesRecordSchema.parse({
      timezone: 'Asia/Shanghai', displayCurrency: 'CNY', revision: 2,
      updatedAt: '2026-08-25T00:00:00.000Z',
    })).toMatchObject({ revision: 2 })
    const usage = {
      startedAt: '2026-08-01T00:00:00.000Z', endedAt: '2026-08-25T00:00:00.000Z',
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
      confirmedPlatformCost: null, pendingCount: 1,
      byokEstimatedCostUsd: '0.01', byokEstimatedCount: 2, byokUnavailableCount: 1,
      timezone: 'Asia/Shanghai', displayCurrency: 'CNY',
      lastSyncAt: '2026-08-25T00:00:00.000Z',
    }
    expect(remoteUsageSnapshotSchema.parse(usage)).toEqual(usage)
    for (const unsafe of [
      { ...usage, ownerUserId: 'alice' },
      { ...usage, apiKey: 'secret' },
      { ...usage, apiKeyFingerprint: 'fingerprint' },
    ]) expect(remoteUsageSnapshotSchema.safeParse(unsafe).success).toBe(false)
  })

  it('exposes safe cloud-sync errors', () => {
    for (const code of [
      'SYNC_CONFLICT',
      'SYNC_FAILED',
      'UPGRADE_REQUIRED',
      'IMPORT_CONFIRMATION_REQUIRED',
      'OUTBOX_LIMIT_EXCEEDED',
    ] as const) {
      expect(appErrorCodeSchema.parse(code)).toBe(code)
      expect(toSafeAppError({ code, message: 'sensitive detail' })).toEqual({
        code,
        message: expect.any(String),
      })
    }
  })

  it('validates CloudBase username, password, phone, email, and OTP inputs', () => {
    expect(authCredentialsSchema.parse({ account: '  Alice_1  ', password: '密码密码密码密码' }))
      .toEqual({ account: 'Alice_1', password: '密码密码密码密码' })
    expect(authOtpRequestSchema.parse({
      intent: 'login', channel: 'phone', target: ' 18311032722 ',
    })).toEqual({ intent: 'login', channel: 'phone', target: '18311032722' })
    expect(authOtpRequestSchema.parse({
      intent: 'register',
      channel: 'email',
      target: ' User@Example.com ',
      account: ' Alice_1 ',
      password: 'password',
    })).toEqual({
      intent: 'register',
      channel: 'email',
      target: 'user@example.com',
      account: 'Alice_1',
      password: 'password',
    })
    expect(authOtpVerificationSchema.parse({ challengeId: 'challenge_1', code: '123456' }))
      .toEqual({ challengeId: 'challenge_1', code: '123456' })
    expect(() => authOtpRequestSchema.parse({
      intent: 'login', channel: 'phone', target: '123',
    })).toThrow()
    expect(() => authOtpVerificationSchema.parse({
      challengeId: 'challenge_1', code: '12345',
    })).toThrow()
  })

  it('exposes the CloudBase authentication IPC contract', () => {
    expect(ipcChannels.authSendOtp).toBe('auth:send-otp')
    expect(ipcChannels.authRefreshAuthorization).toBe('auth:refresh-authorization')
    expect(ipcChannels.authVerifyOtp).toBe('auth:verify-otp')
    expect(ipcChannels.authCancelOtp).toBe('auth:cancel-otp')
    expect(ipcChannels.authLoginWithPassword).toBe('auth:login-with-password')
    expect(ipcRequestSchemas[ipcChannels.authCancelOtp].parse({ challengeId: 'challenge_1' }))
      .toEqual({ challengeId: 'challenge_1' })
    expect(ipcResponseSchemas[ipcChannels.authSendOtp].parse({
      challengeId: 'challenge_1', expiresIn: 300,
    })).toEqual({ challengeId: 'challenge_1', expiresIn: 300 })
  })

  it('validates extensible business roles and confirmed capabilities on auth sessions', () => {
    expect(authorizationSnapshotSchema.parse({
      role: 'super_admin',
      capabilities: ['manage_users'],
      version: 3,
      updatedAt: '2026-08-21T00:00:00.000Z',
      confirmed: true,
    })).toMatchObject({ role: 'super_admin', capabilities: ['manage_users'], confirmed: true })
    expect(authorizationSnapshotSchema.parse({
      role: 'support_operator',
      capabilities: [],
      version: 1,
      updatedAt: '2026-08-21T00:00:00.000Z',
      confirmed: true,
    }).role).toBe('support_operator')
    expect(authorizationSnapshotSchema.safeParse({
      role: 'Super Admin', capabilities: [], version: 1, updatedAt: '2026-08-21T00:00:00.000Z', confirmed: true,
    }).success).toBe(false)
    expect(authSessionSchema.parse({
      user: { id: 'cloud_uid', account: 'Alice_1' },
      authenticatedAt: '2026-08-21T00:00:00.000Z',
      authorization: {
        role: 'user', capabilities: [], version: 0, updatedAt: '2026-08-21T00:00:00.000Z', confirmed: true,
      },
    }).authorization.role).toBe('user')
  })

  it('validates strict paged user administration requests and optimistic role updates', () => {
    expect(userAdminListRequestSchema.parse({
      page: 2,
      pageSize: 50,
      filter: { field: 'email', value: 'admin@example.com' },
    })).toEqual({ page: 2, pageSize: 50, filter: { field: 'email', value: 'admin@example.com' } })
    expect(userAdminListRequestSchema.safeParse({ page: 1, pageSize: 25 }).success).toBe(false)
    expect(userAdminListRequestSchema.safeParse({
      page: 1, pageSize: 20, filter: { field: 'all', value: 'alice' }, extra: true,
    }).success).toBe(false)

    expect(userAdminListResponseSchema.parse({
      items: [{
        userId: 'uid_1',
        username: 'Alice_1',
        displayName: 'Alice',
        maskedEmail: 'a***@example.com',
        maskedPhone: '138****8000',
        status: 'active',
        role: 'support_operator',
        roleVersion: 2,
        createdAt: '2026-08-21T00:00:00.000Z',
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    }).items[0]?.role).toBe('support_operator')

    expect(userAdminUpdateRoleRequestSchema.parse({
      requestId: '01K35P3Y6RZXQAG8A3J1AKM5F3',
      targetUserId: 'uid_1',
      newRole: 'super_admin',
      expectedVersion: 1,
    }).newRole).toBe('super_admin')
    expect(userAdminUpdateRoleRequestSchema.safeParse({
      requestId: 'request_1', targetUserId: 'uid_1', newRole: 'support_operator', expectedVersion: 1,
    }).success).toBe(false)
  })

  it.each([
    'AUTH_REQUIRED',
    'AUTH_INVALID_CREDENTIALS',
    'AUTH_ACCOUNT_EXISTS',
    'AUTH_INVALID_OTP',
    'AUTH_OTP_EXPIRED',
    'AUTH_OTP_RATE_LIMITED',
    'AUTH_ACCOUNT_NOT_FOUND',
    'FORBIDDEN',
    'USER_NOT_FOUND',
    'ROLE_CONFLICT',
    'SELF_ROLE_CHANGE_FORBIDDEN',
    'LAST_SUPER_ADMIN',
    'REQUEST_ID_CONFLICT',
    'SERVICE_UNAVAILABLE',
  ] as const)(
    'keeps %s as a safe application error',
    (code) => expect(toSafeAppError({ code })).toMatchObject({ code }),
  )

  it('validates normalized user profiles and rejects identity fields in updates', () => {
    expect(userProfileSchema.parse({
      userId: 'user_1',
      account: 'Alice',
      avatarUrl: 'https://cdn.example.com/profiles/user_1/avatar.webp',
      displayName: 'Alice Zhang',
      gender: 'prefer_not_to_say',
      birthDate: '2000-02-29',
      email: 'alice@example.com',
      phone: '+8613800138000',
      updatedAt: '2026-08-18T00:00:00.000Z',
    })).toMatchObject({ userId: 'user_1', account: 'Alice' })
    expect(userProfileSchema.parse({
      userId: 'cloud_uid',
      account: 'u***@example.com',
    })).toMatchObject({ userId: 'cloud_uid', account: 'u***@example.com' })

    expect(userProfileUpdateSchema.safeParse({ account: 'Mallory' }).success).toBe(false)
    expect(userProfileUpdateSchema.safeParse({ userId: 'user_2' }).success).toBe(false)
    expect(userProfileUpdateSchema.safeParse({ displayName: 'A'.repeat(51) }).success).toBe(false)
    expect(userProfileUpdateSchema.safeParse({ avatarUrl: 'http://cdn.example.com/a.png' }).success).toBe(false)
    expect(userProfileUpdateSchema.safeParse({ email: 'alice@example.com' }).success).toBe(false)
    expect(userProfileUpdateSchema.safeParse({ phone: '+8613800138000' }).success).toBe(false)
    expect(userProfileUpdateSchema.safeParse({ displayName: '', birthDate: '' }).success).toBe(true)
  })

  it('validates strict three-state CloudBase profile snapshots on auth users', () => {
    expect(authUserSchema.parse({
      id: 'cloud_uid',
      account: 'Alice_1',
      profile: {
        displayName: 'Alice',
        avatarUrl: null,
        gender: 'female',
        email: 'alice@example.com',
        phone: null,
      },
    })).toEqual({
      id: 'cloud_uid',
      account: 'Alice_1',
      profile: {
        displayName: 'Alice',
        avatarUrl: null,
        gender: 'female',
        email: 'alice@example.com',
        phone: null,
      },
    })
    expect(authUserSchema.safeParse({
      id: 'cloud_uid', account: 'Alice_1', profile: { avatarUrl: 'http://example.com/a.png' },
    }).success).toBe(false)
    expect(authUserSchema.safeParse({
      id: 'cloud_uid', account: 'Alice_1', profile: { unknown: 'value' },
    }).success).toBe(false)
  })

  it('maps the profile avatar upload failure without exposing provider details', () => {
    expect(toSafeAppError({
      code: 'PROFILE_AVATAR_UPLOAD_FAILED',
      message: 'qiniu secret response',
    })).toEqual({
      code: 'PROFILE_AVATAR_UPLOAD_FAILED',
      message: 'The profile avatar upload failed.',
    })
  })

  it('accepts only fixed model providers with independent defaults', () => {
    const settings = appSettingsSchema.parse({
      theme: 'system',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'deepseek',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
      showCosts: true,
      developerMode: false,
      permissionDefault: 'ask',
      proxy: { enabled: false, bypassDomains: [] },
    })

    expect(settings.activeProvider).toBe('deepseek')
    expect(() => appSettingsSchema.parse({ ...settings, activeProvider: 'custom' })).toThrow()
  })

  it('validates and normalizes strict proxy settings', () => {
    const proxy = {
      enabled: true,
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'https://proxy.example.com:8443',
      socketProxy: 'socks5://127.0.0.1:7891',
      bypassDomains: ['example.com', '*.internal.example', '10.0.0.0/8'],
    }

    expect(proxySettingsSchema.parse(proxy)).toEqual(proxy)
    expect(appSettingsSchema.parse({
      theme: 'system',
      language: 'zh-CN',
      dataDirectory: '/data',
      logDirectory: '/logs',
      activeProvider: 'deepseek',
      defaultModels: {
        deepseek: { text: 'deepseek-v4-flash' },
        openrouter: { text: 'openai/gpt-4.1-mini' },
      },
      showCosts: true,
      developerMode: false,
      permissionDefault: 'ask',
      proxy,
    }).proxy).toEqual(proxy)
    expect(appErrorCodeSchema.parse('NETWORK_PROXY_APPLY_FAILED'))
      .toBe('NETWORK_PROXY_APPLY_FAILED')

    expect(() => proxySettingsSchema.parse({ enabled: true, bypassDomains: [] })).toThrow()
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      httpProxy: 'http://user:pass@127.0.0.1:7890',
      bypassDomains: [],
    })).toThrow()
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      socketProxy: 'http://127.0.0.1:7891',
      bypassDomains: [],
    })).toThrow()
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      httpsProxy: 'http://127.0.0.1',
      bypassDomains: [],
    })).toThrow()

    expect(parseProxyBypassText('Example.com,\n*.internal.example\nexample.com'))
      .toEqual(['example.com', '*.internal.example'])
    expect(parseProxyBypassText('example.com/24\nlocalhost/24')).toEqual([])
    expect(normalizeProxySettings({
      enabled: false,
      httpProxy: ' http://LOCALHOST:7890 ',
      bypassDomains: [' Example.com ', 'example.com'],
    })).toEqual({
      enabled: false,
      httpProxy: 'http://localhost:7890',
      bypassDomains: ['example.com'],
    })
  })

  it('preserves explicit default proxy ports for domains and IPv6 literals', () => {
    for (const [field, address, canonical] of [
      ['httpProxy', 'http://PROXY.example:80', 'http://proxy.example:80'],
      ['httpsProxy', 'https://PROXY.example:443', 'https://proxy.example:443'],
      ['httpProxy', 'http://[2001:db8::1]:80', 'http://[2001:db8::1]:80'],
      ['httpsProxy', 'https://[2001:db8::1]:443', 'https://[2001:db8::1]:443'],
    ] as const) {
      expect(normalizeProxySettings({
        enabled: true,
        [field]: address,
        bypassDomains: [],
      })).toEqual({
        enabled: true,
        [field]: canonical,
        bypassDomains: [],
      })
    }

    expect(() => proxySettingsSchema.parse({
      enabled: true,
      httpProxy: 'http://proxy.example',
      bypassDomains: [],
    })).toThrow()
  })

  it.each([
    ['httpProxy', 'http://proxy.example:0'],
    ['httpsProxy', 'https://proxy.example:0'],
    ['socketProxy', 'socks4://proxy.example:0'],
    ['socketProxy', 'socks5://proxy.example:0'],
  ] as const)('rejects port zero for %s', (field, address) => {
    expect(() => proxySettingsSchema.parse({
      enabled: true,
      [field]: address,
      bypassDomains: [],
    })).toThrow()
  })

  it('rejects every invalid bypass array entry instead of filtering it', () => {
    for (const bypassEntry of [
      'https://example.com',
      'example.com:443',
      'example.com/path',
      '',
      '   ',
      'example.com,internal.example',
      'example.com\ninternal.example',
    ]) {
      expect(() => proxySettingsSchema.parse({
        enabled: false,
        bypassDomains: [bypassEntry],
      })).toThrow()
    }

    expect(() => normalizeProxySettings({
      enabled: false,
      bypassDomains: ['example.com', 'https://private.example'],
    })).toThrow()
  })

  it('accepts generic file attachment blocks without allowing files in media generation blocks', () => {
    const fileBlock = {
      type: 'media' as const,
      blockId: 'block_file_1',
      assetId: 'asset_file_1',
      kind: 'file' as const,
      purpose: 'input' as const,
      name: 'notes.txt',
      mimeType: 'text/plain',
      byteSize: 12,
    }
    const fileAsset = {
      id: 'asset_file_1',
      kind: 'file' as const,
      name: 'notes.txt',
      mimeType: 'text/plain',
      byteSize: 12,
    }

    expect(mediaBlockSchema.parse(fileBlock)).toEqual(fileBlock)
    expect(mediaAssetSchema.parse(fileAsset)).toEqual(fileAsset)
    expect(() => mediaGenerationBlockSchema.parse({
      type: 'media_generation',
      blockId: 'block_file_1',
      jobId: 'job_file_1',
      kind: 'file',
      status: 'pending',
    })).toThrow()
  })

  it('rejects generic file attachments as output media blocks', () => {
    expect(() => mediaBlockSchema.parse({
      type: 'media',
      blockId: 'block_file_output_1',
      assetId: 'asset_file_output_1',
      kind: 'file',
      purpose: 'output',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      byteSize: 12,
    })).toThrow()
  })

  it.each([
    ['deepseek', 'notes.anything', 'text/plain', { mode: 'text' }],
    ['openrouter', 'report.xlsx', 'text/plain', { mode: 'text' }],
    ['openrouter', 'report.pdf', 'application/octet-stream', { mode: 'provider-file', mimeType: 'application/pdf' }],
    ['openrouter', 'sheet.xlsx', 'application/octet-stream', { mode: 'provider-file', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    ['openrouter', 'report.pdf', 'application/pdf', { mode: 'provider-file', mimeType: 'application/pdf' }],
    ['openrouter', 'sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { mode: 'provider-file', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    ['openrouter', 'report.xlsx', 'application/pdf', { mode: 'unsupported' }],
    ['openrouter', 'report.bin', 'application/pdf', { mode: 'unsupported' }],
    ['openrouter', 'report.pdf', 'application/zip', { mode: 'unsupported' }],
    ['openrouter', 'archive.zip', 'application/octet-stream', { mode: 'unsupported' }],
    ['deepseek', 'report.pdf', 'application/pdf', { mode: 'unsupported' }],
  ] as const)('classifies %s %s with %s', (provider, name, mimeType, expected) => {
    expect(chatFileSupport(provider, name, mimeType)).toEqual(expected)
  })

  it('accepts strict persisted media blocks without paths or encoded bytes', () => {
    expect(chatBlockSchema.parse({
      type: 'media',
      blockId: 'block_1',
      assetId: 'asset_1',
      kind: 'image',
      purpose: 'input',
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
    })).toMatchObject({ assetId: 'asset_1', purpose: 'input' })

    expect(() => chatBlockSchema.parse({
      type: 'media',
      blockId: 'block_1',
      assetId: 'asset_1',
      kind: 'image',
      purpose: 'input',
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
      path: '/private/photo.png',
    })).toThrow()

    expect(() => mediaBlockSchema.parse({
      type: 'media',
      blockId: 'block_1',
      assetId: 'asset_1',
      kind: 'image',
      purpose: 'input',
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
      base64: 'c2VjcmV0',
    })).toThrow()
  })

  it('rejects paths and encoded bytes from public media asset metadata', () => {
    const asset = {
      id: 'asset_1',
      kind: 'image' as const,
      name: 'photo.png',
      mimeType: 'image/png',
      byteSize: 12,
    }

    expect(mediaAssetSchema.parse(asset)).toEqual(asset)
    expect(() => mediaAssetSchema.parse({ ...asset, path: '/private/photo.png' })).toThrow()
    expect(() => mediaAssetSchema.parse({ ...asset, base64: 'c2VjcmV0' })).toThrow()
  })

  it('requires normalized cities and exact workflow runtime identity', () => {
    const validWorkflowDetail = {
      id: 'workflow.example', version: '1.0.0', name: '示例工作流', description: '示例',
      author: 'AutoForge', category: 'test', enabled: true, source: 'installed' as const,
      integrity: 'valid' as const, updatedAt: '2026-08-22T00:00:00.000Z', cities: [],
      runtimeIdentity: { id: 'workflow.example', version: '1.0.0', source: 'installed' as const },
      permissions: [], activationExamples: [], activationNegativeExamples: [], timeoutMs: 30_000,
      inputSchema: {}, outputSchema: {},
    }

    expect(workflowDetailSchema.parse({
      ...validWorkflowDetail,
      cities: [' 北京 '],
      runtimeIdentity: {
        id: validWorkflowDetail.id,
        version: validWorkflowDetail.version,
        source: 'development',
        buildHash: 'a'.repeat(64),
      },
      source: 'development',
    }).cities).toEqual(['北京'])
    const workflowWithoutCities = { ...validWorkflowDetail }
    Reflect.deleteProperty(workflowWithoutCities, 'cities')
    expect(workflowDetailSchema.parse(workflowWithoutCities).cities).toEqual([])

    expect(() => workflowDetailSchema.parse({
      ...validWorkflowDetail,
      cities: ['北京', '北京'],
    })).toThrow()
    expect(() => workflowDetailSchema.parse({
      ...validWorkflowDetail,
      runtimeIdentity: {
        id: validWorkflowDetail.id,
        version: validWorkflowDetail.version,
        source: 'installed',
        buildHash: 'a'.repeat(64),
      },
    })).toThrow()
    expect(() => workflowDetailSchema.parse({
      ...validWorkflowDetail,
      runtimeIdentity: {
        id: validWorkflowDetail.id,
        version: validWorkflowDetail.version,
        source: 'development',
        buildHash: 'A'.repeat(64),
      },
      source: 'development',
    })).toThrow()
    expect(() => workflowDetailSchema.parse({
      ...validWorkflowDetail,
      runtimeIdentity: { ...validWorkflowDetail.runtimeIdentity, id: 'workflow.other' },
    })).toThrow()
  })

  it('preserves optional browser continuation metadata without synthesizing it for legacy workflows', () => {
    const legacyWorkflow = {
      id: 'workflow.example', version: '1.0.0', name: '示例工作流', description: '示例',
      author: 'AutoForge', category: 'test', enabled: true, source: 'installed' as const,
      integrity: 'valid' as const, updatedAt: '2026-08-22T00:00:00.000Z', cities: [],
      runtimeIdentity: { id: 'workflow.example', version: '1.0.0', source: 'installed' as const },
      permissions: [], activationExamples: [], activationNegativeExamples: [], timeoutMs: 30_000,
      inputSchema: {}, outputSchema: {},
    }
    const continuation = {
      auth: { loginUrls: ['https://sso.example.gov.cn/login/*'], loggedIn: ['role=button[name="退出"]'] },
      readableRegions: ['role=main'],
      manualActions: [{ locator: 'role=button[name="正式提交"]', reason: '正式提交必须由用户完成' }],
    }

    expect(workflowDetailSchema.parse({ ...legacyWorkflow, browserContinuation: continuation }).browserContinuation)
      .toEqual(continuation)
    expect(workflowDetailSchema.parse(legacyWorkflow)).not.toHaveProperty('browserContinuation')
    expect(() => workflowDetailSchema.parse({
      ...legacyWorkflow,
      browserContinuation: { manualActions: [{ locator: 'text=提交', reason: '提交' }] },
    })).toThrow()
    expect(() => workflowDetailSchema.parse({
      ...legacyWorkflow,
      browserContinuation: {
        manualActions: [
          { locator: 'role=button[name="正式提交"]', reason: '正式提交必须由用户完成' },
          { locator: 'role=button[name="正式提交"]', reason: '正式提交必须由用户完成' },
        ],
      },
    })).toThrow()
    expect(() => workflowDetailSchema.parse({
      ...legacyWorkflow,
      browserContinuation: {
        readableRegions: Array.from({ length: 33 }, (_, index) => `css=#region-${index}`),
      },
    })).toThrow()
  })

  it('keeps browser status and audit IPC payloads bounded and redacted', () => {
    expect(chatBlockSchema.parse({
      type: 'browser_status', blockId: 'browser_status_1', requestId: 'request_1', bindingId: 'binding_1',
      siteLabel: '北京市工作居住证', origin: 'https://fw.bjrcgz.gov.cn', state: 'acting',
      actionSummary: '读取工作居住证状态',
    })).toMatchObject({ type: 'browser_status', state: 'acting' })
    expect(chatBlockSchema.parse({
      type: 'browser_status', blockId: 'browser_status_port', requestId: 'request_1', bindingId: 'binding_1',
      siteLabel: '北京市工作居住证', origin: 'https://fw.bjrcgz.gov.cn:8443', state: 'acting',
    })).toMatchObject({ origin: 'https://fw.bjrcgz.gov.cn:8443' })
    expect(chatBlockSchema.parse({
      type: 'browser_status', blockId: 'browser_status_manual', requestId: 'request_1',
      bindingId: 'binding_1', siteLabel: '事项办理', origin: 'https://service.example',
      state: 'awaiting_user', errorCode: 'MANUAL_INTERVENTION_REQUIRED',
    })).toMatchObject({ errorCode: 'MANUAL_INTERVENTION_REQUIRED' })
    expect(chatBlockSchema.safeParse({
      type: 'browser_status', blockId: 'browser_status_1', requestId: 'request_1', bindingId: 'binding_1',
      siteLabel: '北京市工作居住证', origin: 'https://fw.bjrcgz.gov.cn?token=secret', state: 'acting',
    }).success).toBe(false)
    expect(chatBlockSchema.safeParse({
      type: 'browser_status', blockId: 'browser_status_1', requestId: 'request_1', bindingId: 'binding_1',
      siteLabel: '北京市工作居住证', origin: 'https://fw.bjrcgz.gov.cn', state: 'acting',
      actionSummary: 'x'.repeat(501),
    }).success).toBe(false)

    expect(browserActionAuditEntrySchema.parse({
      id: 'audit_1', bindingId: 'binding_1', sequence: 1, origin: 'https://fw.bjrcgz.gov.cn',
      action: 'inspect', targetSummary: '工作居住证信息', risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
    })).toMatchObject({ id: 'audit_1', outcome: 'completed' })
    expect(browserActionAuditEntrySchema.parse({
      id: 'audit_port', bindingId: 'binding_1', sequence: 2, origin: 'https://fw.bjrcgz.gov.cn:8443',
      action: 'inspect', targetSummary: '工作居住证信息', risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
    })).toMatchObject({ origin: 'https://fw.bjrcgz.gov.cn:8443' })
    for (const origin of [
      'http://fw.bjrcgz.gov.cn:8443',
      'https://user@fw.bjrcgz.gov.cn:8443',
      'https://fw.bjrcgz.gov.cn:8443/path',
      'https://fw.bjrcgz.gov.cn:99999',
    ]) {
      expect(chatBlockSchema.safeParse({
        type: 'browser_status', blockId: 'browser_status_invalid', requestId: 'request_1', bindingId: 'binding_1',
        siteLabel: '北京市工作居住证', origin, state: 'acting',
      }).success).toBe(false)
      expect(browserActionAuditEntrySchema.safeParse({
        id: 'audit_invalid', bindingId: 'binding_1', sequence: 3, origin,
        action: 'inspect', targetSummary: '工作居住证信息', risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
      }).success).toBe(false)
    }
    expect(browserActionAuditEntrySchema.safeParse({
      id: 'audit_1', bindingId: 'binding_1', sequence: 1, origin: 'https://fw.bjrcgz.gov.cn',
      action: 'inspect', targetSummary: 'password=secret', risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
    }).success).toBe(false)
    for (const path of [
      '/Users/alice/secret.txt',
      'C:\\Users\\Alice\\secret.txt',
      '\\\\fileserver\\private\\secret.txt',
      'filePath=/tmp/a',
      'file:///Users/alice/secret.txt',
      'FILE:///Users/alice/secret.txt',
    ]) {
      expect(browserActionAuditEntrySchema.safeParse({
        id: 'audit_1', bindingId: 'binding_1', sequence: 1, origin: 'https://fw.bjrcgz.gov.cn',
        action: 'inspect', targetSummary: path, risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
      }).success).toBe(false)
    }

    expect(ipcChannels.chatTakeOverBrowser).toBe('chat:take-over-browser')
    expect(ipcRequestSchemas[ipcChannels.chatTakeOverBrowser].parse({ requestId: 'request_1', bindingId: 'binding_1' }))
      .toEqual({ requestId: 'request_1', bindingId: 'binding_1' })
    expect(ipcRequestSchemas[ipcChannels.chatListBrowserAudit].parse({ bindingId: 'binding_1' }))
      .toEqual({ bindingId: 'binding_1' })
    expect(ipcRequestSchemas[ipcChannels.settingsClearBrowserData].parse(undefined)).toBeUndefined()
    expect(ipcResponseSchemas[ipcChannels.chatListBrowserAudit].parse([{
      id: 'audit_1', bindingId: 'binding_1', sequence: 1, origin: 'https://fw.bjrcgz.gov.cn',
      action: 'inspect', targetSummary: '工作居住证信息', risk: 'sensitive_read', outcome: 'completed', createdAt: 11,
    }])).toHaveLength(1)
    expect(toSafeAppError({ code: 'PAGE_BUSY', message: 'tab id tab_1' })).toEqual({
      code: 'PAGE_BUSY', message: expect.any(String),
    })
  })

  it('accepts strict system-owned workflow status and provenance blocks', () => {
    expect(chatBlockSchema.parse({
      type: 'workflow_status', blockId: 'status_1', executionId: 'exec_1',
      workflowId: 'workflow.beijing', workflowName: '北京工作居住证',
      workflowVersion: '1.0.0', source: 'development', buildHash: 'a'.repeat(64),
      city: '北京', status: 'running', executionAvailable: true, executionIndex: 1, executionLimit: 5,
    }).type).toBe('workflow_status')
    expect(chatBlockSchema.parse({
      type: 'workflow_provenance', blockId: 'provenance_1',
      entries: [{ executionId: 'exec_1', workflowId: 'workflow.beijing',
        workflowName: '北京工作居住证', workflowVersion: '1.0.0',
        source: 'development', buildHash: 'a'.repeat(64), city: '北京', status: 'completed' }],
    }).type).toBe('workflow_provenance')
    expect(() => chatBlockSchema.parse({
      type: 'workflow_status', blockId: 'status_1', executionId: 'exec_1',
      workflowId: 'workflow.beijing', workflowName: '北京工作居住证', workflowVersion: '1.0.0',
      source: 'installed', buildHash: 'a'.repeat(64), status: 'running', executionAvailable: true,
      executionIndex: 1, executionLimit: 5,
    })).toThrow()
    expect(() => chatBlockSchema.parse({
      type: 'workflow_status', blockId: 'status_1', executionId: 'exec_1',
      workflowId: 'workflow.beijing', workflowName: '北京工作居住证', workflowVersion: '1.0.0',
      source: 'installed', status: 'running', executionAvailable: true, executionIndex: 6, executionLimit: 6,
    })).toThrow()
  })

  it('requires a stable Main-owned approval identity and authoritative state', () => {
    const approval = {
      type: 'approval' as const,
      blockId: 'approval_1',
      state: 'pending' as const,
      executionId: 'execution_1',
      workflowId: 'workflow.beijing', workflowName: '北京工作居住证', workflowVersion: '1.0.0',
      source: 'installed' as const, actionSummary: '填写并点击提交', permissionIndex: 0,
      capability: 'browser.click' as const, scope: { origins: ['https://example.com'] },
      scopeHash: 'a'.repeat(64),
    }

    expect(chatBlockSchema.parse(approval)).toMatchObject({ blockId: 'approval_1', state: 'pending' })
    for (const state of ['approved', 'denied', 'expired', 'cancelled', 'invalidated'] as const) {
      expect(chatBlockSchema.parse({ ...approval, state })).toMatchObject({ state })
    }
    expect(chatBlockSchema.safeParse({ ...approval, blockId: undefined }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...approval, state: undefined }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...approval, state: 'always' }).success).toBe(false)
  })

  it('accepts only a declared formats scope for file conversion approval blocks', () => {
    const approval = {
      type: 'approval' as const,
      blockId: 'approval_1',
      state: 'pending' as const,
      executionId: 'execution_1',
      workflowId: 'workflow.convert', workflowName: 'Convert file', workflowVersion: '1.0.0',
      source: 'installed' as const, actionSummary: 'Convert attachment 0 to PDF', permissionIndex: 0,
      capability: 'file.convert' as const, scope: { formats: ['pdf'] },
      scopeHash: 'a'.repeat(64),
    }

    expect(chatBlockSchema.parse(approval)).toMatchObject({
      capability: 'file.convert', scope: { formats: ['pdf'] },
    })
    expect(chatBlockSchema.safeParse({ ...approval, scope: {} }).success).toBe(false)
    expect(chatBlockSchema.safeParse({
      ...approval,
      scope: { origins: ['https://example.com'] },
    }).success).toBe(false)
  })

  it('requires Main-owned execution availability with strict status semantics', () => {
    const status = {
      type: 'workflow_status' as const,
      blockId: 'status_1', executionId: 'exec_1', workflowId: 'workflow.beijing',
      workflowName: '北京工作居住证', workflowVersion: '1.0.0', source: 'installed' as const,
      executionIndex: 1, executionLimit: 5,
    }

    expect(chatBlockSchema.parse({ ...status, status: 'queued', executionAvailable: false }))
      .toMatchObject({ status: 'queued', executionAvailable: false })
    expect(chatBlockSchema.parse({ ...status, status: 'failed', executionAvailable: false,
      errorCode: 'WORKFLOW_CHANGED', errorSummary: 'The workflow changed before it could run. Review and try again.' }))
      .toMatchObject({ status: 'failed', executionAvailable: false })
    expect(chatBlockSchema.parse({ ...status, status: 'failed', executionAvailable: true,
      errorCode: 'WORKER_TIMEOUT', errorSummary: 'The worker timed out.' }))
      .toMatchObject({ status: 'failed', executionAvailable: true })
    expect(chatBlockSchema.safeParse({ ...status, status: 'queued', executionAvailable: true }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...status, status: 'running', executionAvailable: false }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...status, status: 'completed', executionAvailable: false }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...status, status: 'queued' }).success).toBe(false)
  })

  it('binds safe workflow status errors to valid terminal states', () => {
    const completed = {
      type: 'workflow_status' as const,
      blockId: 'status_1', executionId: 'exec_1',
      workflowId: 'workflow.beijing', workflowName: '北京工作居住证',
      workflowVersion: '1.0.0', source: 'installed' as const,
      status: 'completed' as const, executionAvailable: true, executionIndex: 1, executionLimit: 5,
      errorCode: 'RESULT_TOO_LARGE' as const,
      errorSummary: 'The workflow result is too large.',
    }

    expect(chatBlockSchema.parse(completed)).toMatchObject({
      status: 'completed', errorCode: 'RESULT_TOO_LARGE',
      errorSummary: 'The workflow result is too large.',
    })
    expect(chatBlockSchema.safeParse({ ...completed, status: 'failed' }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...completed, status: 'running' }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...completed, errorCode: 'INVALID_OUTPUT' }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...completed, errorSummary: undefined }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...completed, errorCode: undefined }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...completed, errorSummary: 'x'.repeat(501) }).success).toBe(false)
  })

  it('requires exact conversation ownership for public draft removal', () => {
    const schema = ipcRequestSchemas[ipcChannels.mediaRemoveDraft]
    expect(schema.parse({
      conversationId: 'conversation_1',
      assetId: 'asset_1',
    })).toEqual({
      conversationId: 'conversation_1',
      assetId: 'asset_1',
    })
    expect(() => schema.parse({ assetId: 'asset_1' })).toThrow()
    expect(() => schema.parse({
      conversationId: 'conversation_1',
      assetId: 'asset_1',
      extra: true,
    })).toThrow()
  })

  it('applies only the documented generation defaults', () => {
    expect(generationOptionsSchema.parse({
      image: { count: 1 },
      audio: {},
      video: {},
    })).toEqual({
      image: { count: 1, resolution: '1K', aspectRatio: 'auto', format: 'png' },
      audio: { format: 'mp3' },
      video: { durationSeconds: 5, resolution: '720p', aspectRatio: 'auto', generateAudio: false },
    })
  })

  it('requires capability-rich model metadata', () => {
    const model = modelInfoSchema.parse({
      id: 'openai/image-model',
      name: 'Image model',
      inputModalities: ['text', 'image'],
      outputModalities: ['image'],
      supportsTools: false,
      generation: {
        image: {
          resolutions: ['1K'],
          aspectRatios: ['auto'],
          formats: ['png'],
          maxCount: 1,
        },
      },
    })

    expect(model.generation.image?.formats).toEqual(['png'])

    const video = modelInfoSchema.parse({
      id: 'openrouter/video-model',
      name: 'Video model',
      inputModalities: ['text', 'image'],
      outputModalities: ['video'],
      supportsTools: false,
      generation: {
        video: {
          resolutions: ['1080p'],
          aspectRatios: ['16:9'],
          durations: [4, 8],
          supportsAudio: true,
          frameImages: ['first_frame', 'last_frame'],
          maxReferenceImages: 1,
        },
      },
    })

    expect(video.generation.video?.frameImages).toEqual(['first_frame', 'last_frame'])
    expect(video.generation.video?.maxReferenceImages).toBe(1)
    expect(() => modelInfoSchema.parse({
      ...video,
      generation: {
        video: { ...video.generation.video!, maxReferenceImages: 0 },
      },
    })).toThrow()
    expect(() => modelInfoSchema.parse({ ...model, supportsTools: undefined })).toThrow()
  })

  it('recognizes every safe media error code and no unknown code', () => {
    const safeMediaCodes = [
      'MEDIA_TYPE_UNSUPPORTED',
      'MEDIA_ATTACHMENT_LIMIT_EXCEEDED',
      'MEDIA_SIZE_LIMIT_EXCEEDED',
      'MEDIA_MIME_MISMATCH',
      'MEDIA_IMPORT_FAILED',
      'MEDIA_ASSET_UNAVAILABLE',
      'MEDIA_STORAGE_FULL',
      'MODEL_MODALITY_UNSUPPORTED',
      'MEDIA_GENERATION_FAILED',
      'MEDIA_DOWNLOAD_FAILED',
      'MEDIA_GENERATION_TIMEOUT',
    ] as const

    expect(safeMediaCodes.map((code) => appErrorCodeSchema.parse(code))).toEqual(safeMediaCodes)
    expect(() => appErrorCodeSchema.parse('MEDIA_UNKNOWN')).toThrow()
  })

  it.each([
    ['MODEL_PROVIDER_INVALID_REQUEST', 'The model provider rejected the request.'],
    ['MODEL_PROVIDER_PAYMENT_REQUIRED', 'The model provider account has insufficient credit.'],
    ['MODEL_PROVIDER_RATE_LIMITED', 'The model provider rate limited the request.'],
    ['MODEL_PROVIDER_TIMEOUT', 'The model provider request timed out.'],
    ['MODEL_PROVIDER_UNAVAILABLE', 'The model provider is unavailable.'],
  ] as const)('keeps %s as a fixed safe provider error', (code, message) => {
    expect(appErrorCodeSchema.parse(code)).toBe(code)
    expect(toSafeAppError({ code, message: 'RAW_PROVIDER_MESSAGE' })).toEqual({ code, message })
  })

  it('recognizes the safe context-limit error code', () => {
    expect(appErrorCodeSchema.parse('CONTEXT_LIMIT_EXCEEDED'))
      .toBe('CONTEXT_LIMIT_EXCEEDED')
  })

  it('recognizes every safe workflow tool runtime error code', () => {
    const safeWorkflowToolCodes = [
      'CITY_REQUIRED',
      'CITY_NOT_SUPPORTED',
      'WORKFLOW_CHANGED',
      'INVALID_TOOL_SEQUENCE',
      'TOOL_CALL_LIMIT',
      'INVALID_OUTPUT',
      'RESULT_TOO_LARGE',
    ] as const

    expect(safeWorkflowToolCodes.map((code) => appErrorCodeSchema.parse(code))).toEqual(safeWorkflowToolCodes)
    for (const code of safeWorkflowToolCodes) {
      expect(toSafeAppError({ code, message: 'RAW_WORKFLOW_ERROR' })).toMatchObject({ code })
      expect(toSafeAppError({ code, message: 'RAW_WORKFLOW_ERROR' }).message).not.toBe('RAW_WORKFLOW_ERROR')
    }
  })

  it('replaces only the matching media block through a strict block update event', () => {
    expect(chatEventSchema.parse({
      type: 'block_update',
      conversationId: 'conversation_1',
      messageId: 'message_1',
      blockId: 'block_1',
      block: {
        type: 'media_generation',
        blockId: 'block_1',
        jobId: 'job_1',
        kind: 'video',
        status: 'in_progress',
      },
    })).toMatchObject({ type: 'block_update', blockId: 'block_1' })

    expect(() => chatEventSchema.parse({
      type: 'block_update',
      conversationId: 'conversation_1',
      messageId: 'message_1',
      blockId: 'block_1',
      block: {
        type: 'media_generation',
        blockId: 'block_2',
        jobId: 'job_1',
        kind: 'video',
        status: 'in_progress',
      },
    })).toThrow()
  })

  it('carries an AI-generated conversation title as a strict chat event', () => {
    expect(chatEventSchema.parse({
      type: 'conversation_title_updated',
      conversationId: 'conversation_1',
      title: '北京工作居住证办理',
      updatedAt: '2026-08-23T12:00:00.000Z',
    })).toEqual({
      type: 'conversation_title_updated',
      conversationId: 'conversation_1',
      title: '北京工作居住证办理',
      updatedAt: '2026-08-23T12:00:00.000Z',
    })

    expect(() => chatEventSchema.parse({
      type: 'conversation_title_updated',
      conversationId: 'conversation_1',
      title: '北京工作居住证办理',
      updatedAt: 'not-a-timestamp',
      ignored: true,
    })).toThrow()
  })

  it('carries an owner-free strict conversation sync projection event', () => {
    const event = {
      type: 'conversation_updated',
      conversationId: 'conversation_1',
      conversation: {
        id: 'conversation_1',
        title: 'Synced title',
        titleState: 'user_named',
        revision: 2,
        syncState: 'synced',
        createdAt: '2026-08-23T12:00:00.000Z',
        lastActivityAt: '2026-08-23T12:01:00.000Z',
        metadataUpdatedAt: '2026-08-23T12:01:00.000Z',
      },
    }
    expect(chatEventSchema.parse(event)).toEqual(event)
    expect(() => chatEventSchema.parse({
      ...event,
      conversation: { ...event.conversation, userId: 'private-owner' },
    })).toThrow()
    expect(() => chatEventSchema.parse({
      ...event,
      conversationId: 'different-conversation',
    })).toThrow()
  })

  it('carries only a conversation ID in a strict removal event', () => {
    const event = {
      type: 'conversation_removed',
      conversationId: 'conversation_1',
    }
    expect(chatEventSchema.parse(event)).toEqual(event)
    for (const privateField of [
      { uid: 'private-owner' },
      { ownerUserId: 'private-owner' },
      { revision: 3 },
      { tombstone: { deletedAt: '2026-08-25T00:00:00.000Z' } },
    ]) {
      expect(() => chatEventSchema.parse({ ...event, ...privateField })).toThrow()
    }
  })

  it('carries a strict owner-free global sync warning state event', () => {
    const warning = {
      type: 'sync_warning_updated',
      warningSince: '2026-08-23T12:00:00.000Z',
    }
    expect(chatEventSchema.parse(warning)).toEqual(warning)
    expect(chatEventSchema.parse({ type: 'sync_warning_updated' }))
      .toEqual({ type: 'sync_warning_updated' })
    for (const privateField of [{ userId: 'alice' }, { uid: 'alice' }, { extra: true }]) {
      expect(() => chatEventSchema.parse({ ...warning, ...privateField })).toThrow()
    }
  })

  it('allows attachment-only understanding but rejects empty or encoded sends', () => {
    expect(chatSendInputSchema.parse({
      conversationId: 'conversation_1',
      content: '',
      assetIds: ['asset_1'],
      outputType: 'auto',
      generation: { image: { count: 1 }, audio: {}, video: {} },
    })).toMatchObject({ assetIds: ['asset_1'], outputType: 'auto' })

    expect(() => chatSendInputSchema.parse({
      conversationId: 'conversation_1',
      content: '',
      assetIds: [],
      outputType: 'text',
      generation: { image: { count: 1 }, audio: {}, video: {} },
    })).toThrow()

    expect(() => chatSendInputSchema.parse({
      conversationId: 'conversation_1',
      content: 'describe this image',
      assetIds: ['asset_1'],
      outputType: 'auto',
      generation: { image: { count: 1 }, audio: {}, video: {} },
      base64: 'c2VjcmV0',
    })).toThrow()
  })

  it('requires provider-scoped credential status without exposing a key', () => {
    const status = providerCredentialStatusSchema.parse({
      provider: 'deepseek',
      configured: true,
      validation: 'valid',
    })

    expect(status).toEqual({
      provider: 'deepseek',
      configured: true,
      validation: 'valid',
    })
    expect(status).not.toHaveProperty('apiKey')
    expect(providerCredentialStatusSchema.parse({
      provider: 'openrouter',
      configured: true,
      validation: 'denied',
    }).validation).toBe('denied')
  })

  it('declares provider-aware settings channels and a neutral provider error', () => {
    expect(ipcChannels.settingsSaveProviderApiKey).toBe('settings:save-provider-api-key')
    expect(ipcChannels.settingsClearProviderApiKey).toBe('settings:clear-provider-api-key')
    expect(ipcChannels.settingsValidateProviderCredential).toBe('settings:validate-provider-credential')
    expect(ipcChannels.settingsListProviderModels).toBe('settings:list-provider-models')
    expect(appErrorCodeSchema.parse('MODEL_PROVIDER_ACCESS_DENIED')).toBe('MODEL_PROVIDER_ACCESS_DENIED')
    expect(appErrorCodeSchema.parse('MODEL_PROVIDER_REQUEST_FAILED')).toBe('MODEL_PROVIDER_REQUEST_FAILED')
    expect(appErrorCodeSchema.parse('OPENROUTER_REQUEST_FAILED')).toBe('OPENROUTER_REQUEST_FAILED')
    expect(listProviderModelsRequestSchema.parse({ provider: 'openrouter' }))
      .toEqual({ provider: 'openrouter', refresh: false })
    expect(listProviderModelsRequestSchema.parse({ provider: 'openrouter', refresh: true }))
      .toEqual({ provider: 'openrouter', refresh: true })
    expect(() => listProviderModelsRequestSchema.parse({ provider: 'openrouter', refresh: 'yes' })).toThrow()
  })

  it('requires internally consistent token usage snapshots', () => {
    const period = (
      startedAt: string,
      endedAt: string,
      inputTokens: number,
      outputTokens: number,
      model = 'alpha/model',
      openRouterCostUsd = '0',
      openRouterKnownCostCount = 0,
      openRouterUnknownCostCount = 0,
    ) => ({
      startedAt,
      endedAt,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      openRouterCostUsd,
      openRouterKnownCostCount,
      openRouterUnknownCostCount,
      models: inputTokens + outputTokens === 0
        ? []
        : [{
            provider: 'openrouter' as const,
            model,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            openRouterCostUsd,
            openRouterKnownCostCount,
            openRouterUnknownCostCount,
          }],
      trend: inputTokens + outputTokens === 0
        ? []
        : [{ startedAt, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }],
    })

    const snapshot = {
      generatedAt: '2026-08-17T04:30:00.000Z',
      today: period('2026-08-16T16:00:00.000Z', '2026-08-17T04:30:00.000Z', 7, 3, 'alpha/model', '0.0000001', 1),
      yesterday: period('2026-08-15T16:00:00.000Z', '2026-08-16T16:00:00.000Z', 2, 1),
      week: period('2026-08-16T16:00:00.000Z', '2026-08-17T04:30:00.000Z', 7, 3),
      month: period('2026-07-31T16:00:00.000Z', '2026-08-17T04:30:00.000Z', 9, 4, 'alpha/model', '123456789.123', 2, 1),
      allTime: period('2026-07-01T01:00:00.000Z', '2026-08-17T04:30:00.000Z', 12, 6),
    }
    const withTodayTokenCounts = (inputTokens: number, outputTokens: number) => {
      const totalTokens = inputTokens + outputTokens
      return {
        ...snapshot,
        today: {
          ...snapshot.today,
          inputTokens,
          outputTokens,
          totalTokens,
          models: [{ ...snapshot.today.models[0], inputTokens, outputTokens, totalTokens }],
          trend: [{ ...snapshot.today.trend[0], inputTokens, outputTokens, totalTokens }],
        },
      }
    }
    const expectTimestampFailure = (value: unknown, path: Array<string | number>) => {
      const result = tokenUsageSnapshotSchema.safeParse(value)
      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path, code: 'invalid_format', format: 'datetime' }),
      ]))
    }

    expect(tokenUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    for (const invalidCost of ['01', '1.0', '1e-7', '-1', '', 1]) {
      const invalidSnapshot = {
        ...snapshot,
        today: {
          ...snapshot.today,
          openRouterCostUsd: invalidCost,
          models: snapshot.today.models.map((model) => ({ ...model, openRouterCostUsd: invalidCost })),
        },
      }
      expect(
        () => tokenUsageSnapshotSchema.safeParse(invalidSnapshot),
        `safeParse must not throw for invalid cost ${String(invalidCost)}`,
      ).not.toThrow()
      expect(
        tokenUsageSnapshotSchema.safeParse(invalidSnapshot).success,
        `invalid cost ${String(invalidCost)}`,
      ).toBe(false)
    }
    for (const invalidCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => tokenUsageSnapshotSchema.parse({
        ...snapshot,
        today: {
          ...snapshot.today,
          openRouterKnownCostCount: invalidCount,
          models: snapshot.today.models.map((model) => ({ ...model, openRouterKnownCostCount: invalidCount })),
        },
      }), `invalid count ${invalidCount}`).toThrow()
    }
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: {
        ...snapshot.today,
        models: snapshot.today.models.map((model) => {
          const modelWithoutProvider: Partial<typeof model> = { ...model }
          delete modelWithoutProvider.provider
          return modelWithoutProvider
        }),
      },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: {
        ...snapshot.today,
        openRouterCostUsd: '0',
      },
    })).toThrow()
    for (const [description, inputTokens, outputTokens] of [
      ['negative token count', -1, 3],
      ['fractional token count', 1.5, 3],
      ['unsafe token count', Number.MAX_SAFE_INTEGER + 1, 0],
    ] as const) {
      expect(() => tokenUsageSnapshotSchema.parse(withTodayTokenCounts(inputTokens, outputTokens)), description)
        .toThrow()
    }
    expectTimestampFailure({
      ...snapshot,
      generatedAt: 'not-a-timestamp',
    }, ['generatedAt'])
    expectTimestampFailure({
      ...snapshot,
      today: { ...snapshot.today, startedAt: 'not-a-timestamp' },
    }, ['today', 'startedAt'])
    expectTimestampFailure({
      ...snapshot,
      today: {
        ...snapshot.today,
        trend: [{ ...snapshot.today.trend[0], startedAt: 'not-a-timestamp' }],
      },
    }, ['today', 'trend', 0, 'startedAt'])
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: { ...snapshot.today, startedAt: '2026-08-18T00:00:00.000Z' },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: {
        ...snapshot.today,
        trend: [
          { startedAt: '2026-08-17T03:00:00.000Z', inputTokens: 4, outputTokens: 1, totalTokens: 5 },
          { startedAt: '2026-08-17T02:00:00.000Z', inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        ],
      },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: {
        ...snapshot.today,
        trend: [{ ...snapshot.today.trend[0], totalTokens: 9 }],
      },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: { ...snapshot.today, inputTokens: 8, totalTokens: 11 },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: {
        ...snapshot.today,
        models: [
          ...snapshot.today.models,
          { model: 'alpha/model', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        ],
      },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      today: {
        ...snapshot.today,
        trend: [{ ...snapshot.today.trend[0], startedAt: snapshot.today.endedAt }],
      },
    })).toThrow()
    expect(() => tokenUsageSnapshotSchema.parse({
      ...snapshot,
      yesterday: { ...snapshot.yesterday, endedAt: '2026-08-16T15:59:59.999Z' },
    })).toThrow()
    expect(ipcChannels.settingsGetTokenUsage).toBe('settings:get-token-usage')
    expect(ipcRequestSchemas[ipcChannels.settingsGetTokenUsage].parse(undefined)).toBeUndefined()
    expect(ipcResponseSchemas[ipcChannels.settingsGetTokenUsage].parse(snapshot)).toEqual(snapshot)
  })

  it('requires exact pending workflow identity on approval blocks', () => {
    expect(() => chatBlockSchema.parse({
      type: 'approval', blockId: 'approval_1', state: 'pending', executionId: 'exec_1', workflowId: 'browser.search.baidu',
      workflowName: '百度搜索', source: 'installed', actionSummary: '打开百度首页', permissionIndex: 0,
      capability: 'browser.navigate', scope: { origins: ['https://www.baidu.com'] }, scopeHash: 'a'.repeat(64),
    })).toThrow()
  })

  it('requires bound approval context fields', () => {
    const approval = {
      type: 'approval' as const, blockId: 'approval_1', state: 'pending' as const,
      executionId: 'exec_1', workflowId: 'browser.search.baidu',
      workflowName: '百度搜索', workflowVersion: '1.0.0', source: 'development' as const,
      buildHash: 'a'.repeat(64), city: '北京', actionSummary: '打开百度首页', permissionIndex: 0,
      capability: 'browser.open' as const, scope: { origins: ['https://www.baidu.com'] }, scopeHash: 'a'.repeat(64),
    }

    expect(chatBlockSchema.parse(approval)).toMatchObject({
      workflowName: '百度搜索', source: 'development', city: '北京', actionSummary: '打开百度首页',
    })
    expect(chatBlockSchema.parse({
      ...approval,
      scope: { origins: ['*.baidu.com/*', 'https://accounts.baidu.com'] },
    })).toMatchObject({
      scope: { origins: ['*.baidu.com/*', 'https://accounts.baidu.com'] },
    })
    expect(chatBlockSchema.safeParse({ ...approval, actionSummary: 'x'.repeat(501) }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...approval, source: 'installed', buildHash: undefined }).success).toBe(true)
    expect(chatBlockSchema.safeParse({ ...approval, buildHash: undefined }).success).toBe(false)
    expect(chatBlockSchema.safeParse({ ...approval, source: 'installed' }).success).toBe(false)
  })
  it('requires exact workflow identity for removal', () => {
    expect(ipcRequestSchemas[ipcChannels.workflowsRemove].parse({ id: 'browser.search.baidu', version: '1.0.0' }))
      .toEqual({ id: 'browser.search.baidu', version: '1.0.0' })
    expect(() => ipcRequestSchemas[ipcChannels.workflowsRemove].parse({ id: 'browser.search.baidu' })).toThrow()
  })

  it('validates fixed developer entry operations and refreshed project responses', () => {
    const project = {
      id: 'project_1', name: 'Baidu search', rootPath: '/private/project', status: 'new' as const,
      chatAvailability: 'not_built' as const,
      files: ['src/index.ts', 'workflow.json'], directories: ['src'], updatedAt: '2026-07-19T00:00:00.000Z',
    }

    expect(ipcRequestSchemas[ipcChannels.developerCreateEntry].parse({
      projectId: 'project_1', parentPath: 'src', name: 'helpers.ts', kind: 'file',
    })).toEqual({ projectId: 'project_1', parentPath: 'src', name: 'helpers.ts', kind: 'file' })
    expect(ipcRequestSchemas[ipcChannels.developerRenameEntry].parse({
      projectId: 'project_1', relativePath: 'src/helpers.ts', name: 'format.ts',
    })).toEqual({ projectId: 'project_1', relativePath: 'src/helpers.ts', name: 'format.ts' })
    expect(ipcRequestSchemas[ipcChannels.developerDeleteEntry].parse({
      projectId: 'project_1', relativePath: 'src/helpers.ts',
    })).toEqual({ projectId: 'project_1', relativePath: 'src/helpers.ts' })
    expect(ipcResponseSchemas[ipcChannels.developerCreateEntry].parse(project)).toEqual(project)
    expect(() => ipcRequestSchemas[ipcChannels.developerCreateEntry].parse({
      projectId: 'project_1', parentPath: '', name: '../escape.ts', kind: 'file',
    })).toThrow()
    expect(() => ipcResponseSchemas[ipcChannels.developerCreateEntry].parse({
      ...project, chatAvailability: 'unknown',
    })).toThrow()
  })

  it('accepts a semantic developer input validation result', () => {
    const result = { validationError: '搜索关键词不能为空' }

    expect(ipcResponseSchemas[ipcChannels.developerRun].safeParse(result).success).toBe(true)
  })

  it('keeps developer file drafts opaque and attachment ids out of workflow input', () => {
    const draft = { id: 'draft_1', name: 'same.png', mimeType: 'image/png', byteSize: 123 }
    const channel = ipcChannels.developerPickFiles
    expect(channel).toBe('developer:pick-files')
    const responseSchema = ipcResponseSchemas[channel]
    expect(responseSchema).toBeDefined()
    expect(responseSchema!.parse([draft])).toEqual([draft])
    expect(() => responseSchema!.parse([
      { ...draft, path: '/private/source.png' },
    ])).toThrow()
    expect(ipcRequestSchemas[ipcChannels.developerRun].parse({
      projectId: 'project_1', input: { files: [0] }, attachmentIds: ['draft_1'],
    })).toEqual({ projectId: 'project_1', input: { files: [0] }, attachmentIds: ['draft_1'] })
    expect(() => ipcRequestSchemas[ipcChannels.developerRun].parse({
      projectId: 'project_1', input: { files: [0] }, attachmentIds: ['draft_1'], path: '/private/source.png',
    })).toThrow()
    expect(() => ipcRequestSchemas[ipcChannels.developerRun].parse({
      projectId: 'project_1', input: { files: [0, 1] }, attachmentIds: ['draft_1', 'draft_1'],
    })).toThrow()
  })

  it('accepts a semantic developer input validation result', () => {
    const result = { validationError: '搜索关键词不能为空' }

    expect(ipcResponseSchemas[ipcChannels.developerRun].safeParse(result).success).toBe(true)
  })

  it('requires a conversation identity when reading persisted messages', () => {
    expect(ipcRequestSchemas[ipcChannels.chatListMessages].parse({
      conversationId: 'conversation_1', limit: 100,
    })).toEqual({ conversationId: 'conversation_1', limit: 100 })
    expect(() => ipcRequestSchemas[ipcChannels.chatListMessages].parse({ limit: 100 })).toThrow()
  })

  it('rejects a persistent approval without an exact workflow version', () => {
    expect(() => approvalDecisionSchema.parse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      permissionIndex: 0, scopeHash: 'a'.repeat(64),
      capability: 'browser.open', scope: { origins: ['https://www.baidu.com'] },
    })).toThrow()
  })

  it('rejects an unknown worker message instead of forwarding it', () => {
    expect(() => workerMessageSchema.parse({ type: 'shell', command: 'pwd' })).toThrow()
  })

  it('accepts a version-bound persistent approval', () => {
    expect(approvalDecisionSchema.parse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      permissionIndex: 0, scopeHash: 'a'.repeat(64),
      workflowVersion: '1.0.0', capability: 'browser.open',
      scope: { origins: ['https://www.baidu.com'] },
    })).toMatchObject({ decision: 'always', workflowVersion: '1.0.0' })
  })

  it('allows HTTPS URL globs only in declared workflow permissions', () => {
    expect(workflowPermissionSchema.parse({
      capability: 'browser.open',
      scope: { origins: ['*.baidu.com/api/*'] },
    })).toMatchObject({ scope: { origins: ['*.baidu.com/api/*'] } })

    expect(workerMessageSchema.safeParse({
      type: 'capability_request',
      requestId: 'request_1',
      request: {
        capability: 'browser.open',
        scope: { origins: ['https://demo.baidu.com/api'] },
        arguments: { url: 'https://demo.baidu.com/api' },
      },
    }).success).toBe(false)

    expect(approvalDecisionSchema.safeParse({
      executionId: 'exec_1', decision: 'always', workflowId: 'browser.search.baidu',
      permissionIndex: 0, scopeHash: 'a'.repeat(64), workflowVersion: '1.0.0',
      capability: 'browser.open', scope: { origins: ['*.baidu.com'] },
    }).success).toBe(false)

    expect(permissionGrantSchema.safeParse({
      id: 'grant_1', workflowId: 'browser.search.baidu', workflowVersion: '1.0.0',
      capability: 'browser.open', scope: { origins: ['*.baidu.com'] },
      createdAt: '2026-07-19T00:00:00.000Z',
    }).success).toBe(false)

    expect(permissionGrantSchema.safeParse({
      id: 'grant_1', workflowId: 'browser.search.baidu', workflowVersion: '1.0.0',
      capability: 'browser.open', scope: {},
      createdAt: '2026-07-19T00:00:00.000Z',
    }).success).toBe(false)

    expect(executionEventSchema.safeParse({
      type: 'approval_required', executionId: 'exec_1', permissionIndex: 0,
      capability: 'browser.open', scope: { paths: ['/tmp'] }, scopeHash: 'a'.repeat(64),
      occurredAt: '2026-07-19T00:00:00.000Z',
    }).success).toBe(false)

    expect(chatBlockSchema.safeParse({
      type: 'approval', blockId: 'approval_1', state: 'pending', executionId: 'exec_1', workflowId: 'browser.search.baidu',
      workflowName: '百度搜索', workflowVersion: '1.0.0', source: 'installed', actionSummary: '打开百度首页',
      permissionIndex: 0, capability: 'browser.open',
      scope: {}, scopeHash: 'a'.repeat(64),
    }).success).toBe(false)
  })

  it('requires exact identity on a dynamic execution approval event', () => {
    expect(executionEventSchema.parse({
      type: 'approval_required',
      executionId: 'exec_1',
      permissionIndex: 1,
      capability: 'browser.fill',
      scope: { origins: ['https://www.baidu.com'] },
      scopeHash: 'a'.repeat(64),
      occurredAt: '2026-07-19T00:00:00.000Z',
    })).toMatchObject({ type: 'approval_required', permissionIndex: 1 })
  })

  it('accepts a fixed worker response discriminator', () => {
    expect(workerMessageSchema.parse({
      type: 'log', level: 'info', message: 'Opening browser',
    })).toMatchObject({ type: 'log', level: 'info' })
  })

  it('normalizes unknown errors without exposing their value', () => {
    expect(toSafeAppError('secret')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected application error',
    })
  })

  it('does not expose a native error message containing credentials', () => {
    const result = toSafeAppError(new Error('Authorization: Bearer sk-secret'))

    expect(result).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected application error',
    })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })

  it('keeps only the safe code from an error-like object with sensitive details', () => {
    const result = toSafeAppError({
      code: 'INVALID_INPUT',
      message: 'Invalid request',
      details: { apiKey: 'sk-secret', path: '/private/user/path' },
    })

    expect(result).toEqual({
      code: 'INVALID_INPUT',
      message: 'The request is invalid.',
    })
    expect(JSON.stringify(result)).not.toContain('sk-secret')
    expect(JSON.stringify(result)).not.toContain('/private/user/path')
  })
})
