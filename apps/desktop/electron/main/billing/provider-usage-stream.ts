import type {
  ProviderUsageModality,
  ProviderUsageRepository,
} from '../database/repositories.js'
import type {
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
} from '../chat/model-provider.js'
import type { ByokUsageEvent } from '@autoforge/shared'

export interface ProviderStreamAttribution {
  userId: string
  requestId: string
  chatRunId?: string
  model: string
  modality: ProviderUsageModality
}

export interface TrackProviderStreamInput {
  operationKey: string
  purpose: string
  attribution: ProviderStreamAttribution
  request: ModelStreamRequest
  provider: ModelProviderSnapshot
  providerUsage: Pick<ProviderUsageRepository,
    'start' | 'bindIdentity' | 'report' | 'markUnknown' | 'recordByokUsage'>
  id: () => string
  now: () => number
}

export async function* trackProviderStream(
  input: TrackProviderStreamInput,
): AsyncIterable<ModelStreamEvent> {
  const usageId = input.id()
  const startedAt = input.now()
  if (input.provider.providerId === 'openrouter') input.providerUsage.start({
    id: usageId,
    operationKey: input.operationKey,
    userId: input.attribution.userId,
    provider: input.provider.providerId,
    ...(input.provider.apiKeyFingerprint === undefined
      ? {}
      : { apiKeyFingerprint: input.provider.apiKeyFingerprint }),
    requestId: input.attribution.requestId,
    ...(input.attribution.chatRunId === undefined
      ? {}
      : { chatRunId: input.attribution.chatRunId }),
    model: input.attribution.model,
    modality: input.attribution.modality,
    startedAt,
  })

  let generationId: string | undefined
  let costReported = false
  let remoteUsage: Extract<ModelStreamEvent, { type: 'usage' }> | undefined
  try {
    for await (const event of input.provider.provider.stream(input.request)) {
      if (event.type === 'generation') {
        generationId = event.id
        if (input.provider.providerId === 'openrouter') {
          input.providerUsage.bindIdentity(input.operationKey, { generationId })
        }
      } else if (event.type === 'usage') {
        remoteUsage ??= event
      }
      if (input.provider.providerId === 'openrouter'
        && event.type === 'usage' && event.costUsd !== undefined && !costReported) {
        input.providerUsage.report(input.operationKey, {
          ...(generationId === undefined ? {} : { generationId }),
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
          endedAt: input.now(),
        })
        costReported = true
      }
      yield event
    }
  } finally {
    if (input.provider.providerId === 'openrouter' && !costReported) {
      input.providerUsage.markUnknown(input.operationKey, input.now())
    }
    const event: ByokUsageEvent = remoteUsage?.costUsd === undefined
      ? {
          id: usageId, operationId: input.operationKey, purpose: input.purpose,
          credentialOwner: 'user', billable: false, provider: input.provider.providerId,
          model: input.attribution.model, modality: input.attribution.modality,
          ...(remoteUsage?.inputTokens === undefined ? {} : { inputTokens: remoteUsage.inputTokens }),
          ...(remoteUsage?.outputTokens === undefined ? {} : { outputTokens: remoteUsage.outputTokens }),
          costStatus: 'unavailable', occurredAt: new Date(startedAt).toISOString(),
        }
      : {
          id: usageId, operationId: input.operationKey, purpose: input.purpose,
          credentialOwner: 'user', billable: false, provider: input.provider.providerId,
          model: input.attribution.model, modality: input.attribution.modality,
          inputTokens: remoteUsage.inputTokens, outputTokens: remoteUsage.outputTokens,
          costStatus: 'estimated', estimatedCostUsd: remoteUsage.costUsd,
          occurredAt: new Date(startedAt).toISOString(),
        }
    input.providerUsage.recordByokUsage?.(event)
  }
}
