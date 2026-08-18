import type {
  ProviderUsageModality,
  ProviderUsageRepository,
} from '../database/repositories.js'
import type {
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
} from '../chat/model-provider.js'

export interface ProviderStreamAttribution {
  userId: string
  requestId: string
  chatRunId?: string
  model: string
  modality: ProviderUsageModality
}

export interface TrackProviderStreamInput {
  operationKey: string
  attribution: ProviderStreamAttribution
  request: ModelStreamRequest
  provider: ModelProviderSnapshot
  providerUsage: Pick<ProviderUsageRepository, 'start' | 'bindIdentity' | 'report' | 'markUnknown'>
  id: () => string
  now: () => number
}

export async function* trackProviderStream(
  input: TrackProviderStreamInput,
): AsyncIterable<ModelStreamEvent> {
  if (input.provider.providerId !== 'openrouter') {
    yield* input.provider.provider.stream(input.request)
    return
  }

  input.providerUsage.start({
    id: input.id(),
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
    startedAt: input.now(),
  })

  let generationId: string | undefined
  let costReported = false
  try {
    for await (const event of input.provider.provider.stream(input.request)) {
      if (event.type === 'generation') {
        generationId = event.id
        input.providerUsage.bindIdentity(input.operationKey, { generationId })
      } else if (event.type === 'usage' && event.costUsd !== undefined && !costReported) {
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
    if (!costReported) input.providerUsage.markUnknown(input.operationKey, input.now())
  }
}
