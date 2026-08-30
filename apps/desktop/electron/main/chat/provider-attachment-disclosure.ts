import type { ModelProviderId } from '@autoforge/shared'
import type {
  ModelProvider,
  ModelProviderSnapshot,
  ModelStreamRequest,
} from './model-provider.js'
import type { ProviderAttachmentAccessDecision } from './attachment-conversion-policy.js'

export interface ProviderAttachmentDisclosure {
  readonly requestId: string
  readonly providerId: ModelProviderId
  readonly access: Readonly<ProviderAttachmentAccessDecision>
  readonly assetIds: readonly string[]
  readonly assetFingerprints: readonly string[]
  readonly forbiddenValues: readonly string[]
}

interface CreateProviderAttachmentDisclosureInput {
  requestId: string
  providerId: ModelProviderId
  access: ProviderAttachmentAccessDecision
  assetIds: readonly string[]
  assetFingerprints: readonly string[]
  forbiddenValues: readonly string[]
}

interface AttachmentDisclosureBinding {
  requestId: string
  providerId: ModelProviderId
  assetIds: readonly string[]
}

const issuedDisclosures = new WeakSet<object>()
const protectedSnapshots = new WeakMap<object, ProviderAttachmentDisclosure>()

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertIssued(
  disclosure: ProviderAttachmentDisclosure | undefined,
  binding: AttachmentDisclosureBinding,
): asserts disclosure is ProviderAttachmentDisclosure {
  if (!disclosure
    || !issuedDisclosures.has(disclosure)
    || !Object.isFrozen(disclosure)
    || !Object.isFrozen(disclosure.access)
    || !Object.isFrozen(disclosure.assetIds)
    || !Object.isFrozen(disclosure.assetFingerprints)
    || !Object.isFrozen(disclosure.forbiddenValues)
    || disclosure.requestId !== binding.requestId
    || disclosure.providerId !== binding.providerId
    || !sameValues(disclosure.assetIds, binding.assetIds)) {
    throw new Error('Attachment disclosure capability is missing or invalid')
  }
}

export function createProviderAttachmentDisclosure(
  input: CreateProviderAttachmentDisclosureInput,
): ProviderAttachmentDisclosure {
  if (input.assetIds.length !== input.assetFingerprints.length) {
    throw new Error('Attachment disclosure fingerprints are incomplete')
  }
  const disclosure = Object.freeze({
    requestId: input.requestId,
    providerId: input.providerId,
    access: Object.freeze({ ...input.access }),
    assetIds: Object.freeze([...input.assetIds]),
    assetFingerprints: Object.freeze([...input.assetFingerprints]),
    forbiddenValues: Object.freeze([...new Set(input.forbiddenValues.filter(Boolean))]),
  })
  issuedDisclosures.add(disclosure)
  return disclosure
}

export function assertAttachmentByteAccess(
  disclosure: ProviderAttachmentDisclosure | undefined,
  binding: AttachmentDisclosureBinding,
): void {
  assertIssued(disclosure, binding)
  if (!disclosure.access.allowProviderBytes || disclosure.access.decision !== 'ordinary') {
    throw new Error('Attachment bytes are not permitted for this request')
  }
}

function assertSafeStreamRequest(
  disclosure: ProviderAttachmentDisclosure,
  request: ModelStreamRequest,
): void {
  if (disclosure.access.decision === 'ordinary') return
  if (request.output?.type === 'audio') throw new Error('Protected attachment request must be text-only')
  if (disclosure.access.decision === 'ambiguous'
    && ((request.tools?.length ?? 0) > 0 || request.toolChoice !== undefined)) {
    throw new Error('Ambiguous attachment request cannot expose tools')
  }
  for (const message of request.messages) {
    if (Array.isArray(message.content)
      && message.content.some((part) => part.type !== 'text')) {
      throw new Error('Protected attachment request contains structured attachment data')
    }
  }
  const payload = JSON.stringify(request)
  if (/"(?:dataBase64|mediaAssetId|sourceId|absolutePath|relativePath|sourceFingerprint)"|(?:data|file):\/\//iu.test(payload)) {
    throw new Error('Protected attachment request contains a forbidden reference')
  }
  if (disclosure.forbiddenValues.some((value) => payload.includes(value))) {
    throw new Error('Protected attachment request contains tainted attachment data')
  }
}

export function protectProviderSnapshot(
  snapshot: ModelProviderSnapshot,
  disclosure: ProviderAttachmentDisclosure,
): ModelProviderSnapshot {
  assertIssued(disclosure, {
    requestId: disclosure.requestId,
    providerId: snapshot.providerId,
    assetIds: disclosure.assetIds,
  })
  const source = snapshot.provider
  const provider: ModelProvider = {
    listModels: source.listModels.bind(source),
    validateCredential: source.validateCredential.bind(source),
    stream: async function* (request) {
      assertSafeStreamRequest(disclosure, request)
      yield* source.stream(request)
    },
    ...(source.generateImage === undefined ? {} : {
      generateImage: async (request) => {
        if (!disclosure.access.allowProviderBytes) {
          throw new Error('Protected attachment request cannot generate image output')
        }
        return source.generateImage!(request)
      },
    }),
    ...(source.submitVideo === undefined ? {} : {
      submitVideo: async (request) => {
        if (!disclosure.access.allowProviderBytes) {
          throw new Error('Protected attachment request cannot submit video output')
        }
        return source.submitVideo!(request)
      },
    }),
    ...(source.pollVideo === undefined ? {} : { pollVideo: source.pollVideo.bind(source) }),
    ...(source.downloadVideo === undefined ? {} : { downloadVideo: source.downloadVideo.bind(source) }),
    ...(source.getGenerationUsage === undefined ? {} : {
      getGenerationUsage: source.getGenerationUsage.bind(source),
    }),
  }
  const protectedSnapshot = Object.freeze({
    ...snapshot,
    provider: Object.freeze(provider),
  })
  protectedSnapshots.set(protectedSnapshot, disclosure)
  return protectedSnapshot
}

export function assertProtectedProviderSnapshot(
  snapshot: ModelProviderSnapshot,
  disclosure: ProviderAttachmentDisclosure | undefined,
  binding: AttachmentDisclosureBinding,
): void {
  if (!disclosure || protectedSnapshots.get(snapshot) !== disclosure) {
    throw new Error('Provider snapshot is not bound to the attachment disclosure capability')
  }
  assertIssued(disclosure, binding)
  if (snapshot.providerId !== binding.providerId) {
    throw new Error('Provider snapshot does not match the attachment disclosure capability')
  }
}
