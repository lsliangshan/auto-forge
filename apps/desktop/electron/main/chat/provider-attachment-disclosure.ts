import type { ModelProviderId } from '@autoforge/shared'
import type {
  ModelImageRequest,
  ModelProvider,
  ModelProviderSnapshot,
  ModelStreamRequest,
  ModelVideoRequest,
} from './model-provider.js'
import {
  isIssuedProviderAttachmentAccessDecision,
  type ProviderAttachmentAccessDecision,
} from './attachment-conversion-policy.js'

export type ProviderAttachmentPurpose = 'main' | 'title'

export interface ProviderAttachmentDisclosure {
  readonly requestId: string
  readonly providerId: ModelProviderId
  readonly credentialEpoch: number
  readonly access: ProviderAttachmentAccessDecision
  readonly assetIds: readonly string[]
  readonly assetFingerprints: readonly string[]
  readonly forbiddenValues: readonly string[]
}

export interface ProviderAttachmentSafeText {
  readonly text: string
}

interface CreateProviderAttachmentDisclosureInput {
  requestId: string
  providerSnapshot: ModelProviderSnapshot
  credentialEpoch: number
  access: ProviderAttachmentAccessDecision
  assetIds: readonly string[]
  assetFingerprints: readonly string[]
  forbiddenValues: readonly string[]
}

interface AttachmentDisclosureBinding {
  requestId: string
  providerId: ModelProviderId
  assetIds: readonly string[]
  assetFingerprints: readonly string[]
}

interface DisclosureAuthority {
  readonly snapshot: ModelProviderSnapshot
  readonly apiKeyFingerprint?: string
}

interface ProtectedSnapshotBinding {
  readonly disclosure: ProviderAttachmentDisclosure
  readonly purpose: ProviderAttachmentPurpose
}

const issuedDisclosures = new WeakSet<object>()
const disclosureAuthorities = new WeakMap<object, DisclosureAuthority>()
const issuedSafeTexts = new WeakMap<object, {
  disclosure: ProviderAttachmentDisclosure
  purpose: ProviderAttachmentPurpose
}>()
const protectedSnapshots = new WeakMap<object, ProtectedSnapshotBinding>()

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
    || !sameValues(disclosure.assetIds, binding.assetIds)
    || !sameValues(disclosure.assetFingerprints, binding.assetFingerprints)) {
    throw new Error('Attachment disclosure capability is missing or invalid')
  }
}

export function createProviderAttachmentDisclosure(
  input: CreateProviderAttachmentDisclosureInput,
): ProviderAttachmentDisclosure {
  if (!isIssuedProviderAttachmentAccessDecision(input.access)) {
    throw new Error('Attachment access decision is missing or invalid')
  }
  if (input.assetIds.length !== input.assetFingerprints.length
    || new Set(input.assetIds).size !== input.assetIds.length
    || !Number.isSafeInteger(input.credentialEpoch)
    || input.credentialEpoch < 0) {
    throw new Error('Attachment disclosure binding is invalid')
  }
  const disclosure = Object.freeze({
    requestId: input.requestId,
    providerId: input.providerSnapshot.providerId,
    credentialEpoch: input.credentialEpoch,
    access: input.access,
    assetIds: Object.freeze([...input.assetIds]),
    assetFingerprints: Object.freeze([...input.assetFingerprints]),
    forbiddenValues: Object.freeze([...new Set(input.forbiddenValues.filter(Boolean))]),
  })
  issuedDisclosures.add(disclosure)
  disclosureAuthorities.set(disclosure, {
    snapshot: input.providerSnapshot,
    ...(input.providerSnapshot.apiKeyFingerprint === undefined
      ? {}
      : { apiKeyFingerprint: input.providerSnapshot.apiKeyFingerprint }),
  })
  return disclosure
}

export function createProviderAttachmentSafeText(
  disclosure: ProviderAttachmentDisclosure,
  purpose: ProviderAttachmentPurpose,
  text: string,
): ProviderAttachmentSafeText {
  assertIssued(disclosure, {
    requestId: disclosure.requestId,
    providerId: disclosure.providerId,
    assetIds: disclosure.assetIds,
    assetFingerprints: disclosure.assetFingerprints,
  })
  const safeText = Object.freeze({ text })
  issuedSafeTexts.set(safeText, { disclosure, purpose })
  return safeText
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

function deepFreezeRequestValue(value: unknown, signal: AbortSignal | undefined): void {
  if (!value || typeof value !== 'object' || value === signal || Object.isFrozen(value)) return
  for (const child of Object.values(value)) deepFreezeRequestValue(child, signal)
  Object.freeze(value)
}

function cloneAndFreezeRequest<T extends ModelStreamRequest | ModelImageRequest | ModelVideoRequest>(request: T): T {
  const { signal, ...cloneable } = request
  const outbound = {
    ...structuredClone(cloneable),
    ...(signal === undefined ? {} : { signal }),
  } as T
  deepFreezeRequestValue(outbound, signal)
  return outbound
}

function assertSafeText(
  disclosure: ProviderAttachmentDisclosure,
  purpose: ProviderAttachmentPurpose,
  safeText: ProviderAttachmentSafeText | undefined,
  request: ModelStreamRequest,
): void {
  if (disclosure.access.decision === 'ordinary') return
  if (safeText === undefined) {
    throw new Error('Protected attachment request is missing signed text')
  }
  const binding = issuedSafeTexts.get(safeText)
  if (!binding || binding.disclosure !== disclosure || binding.purpose !== purpose) {
    throw new Error('Protected attachment request is missing signed text')
  }
  const userMessages = request.messages.filter(({ role }) => role === 'user')
  if (userMessages.length !== 1 || userMessages[0]?.content !== safeText.text) {
    throw new Error('Protected attachment request contains unsigned user text')
  }
}

function assertSafeStreamRequest(
  disclosure: ProviderAttachmentDisclosure,
  purpose: ProviderAttachmentPurpose,
  safeText: ProviderAttachmentSafeText | undefined,
  request: ModelStreamRequest,
): void {
  if (disclosure.access.decision === 'ordinary') return
  assertSafeText(disclosure, purpose, safeText, request)
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
  input: {
    purpose: ProviderAttachmentPurpose
    safeText?: ProviderAttachmentSafeText
  },
): ModelProviderSnapshot {
  assertIssued(disclosure, {
    requestId: disclosure.requestId,
    providerId: snapshot.providerId,
    assetIds: disclosure.assetIds,
    assetFingerprints: disclosure.assetFingerprints,
  })
  const authority = disclosureAuthorities.get(disclosure)
  if (!authority
    || authority.snapshot !== snapshot
    || authority.apiKeyFingerprint !== snapshot.apiKeyFingerprint) {
    throw new Error('Provider snapshot does not match the attachment disclosure capability')
  }
  if (disclosure.access.decision !== 'ordinary') {
    const safeTextBinding = input.safeText === undefined
      ? undefined
      : issuedSafeTexts.get(input.safeText)
    if (!safeTextBinding
      || safeTextBinding.disclosure !== disclosure
      || safeTextBinding.purpose !== input.purpose) {
      throw new Error('Protected attachment snapshot is missing signed text')
    }
  }
  const source = snapshot.provider
  let titleUsed = false
  const provider: ModelProvider = {
    listModels: source.listModels.bind(source),
    validateCredential: source.validateCredential.bind(source),
    stream: (request) => {
      if (input.purpose === 'title' && titleUsed) {
        throw new Error('Attachment title capability has already been used')
      }
      const outbound = cloneAndFreezeRequest(request)
      assertSafeStreamRequest(disclosure, input.purpose, input.safeText, outbound)
      if (input.purpose === 'title') titleUsed = true
      return source.stream(outbound)
    },
    ...(source.generateImage === undefined ? {} : {
      generateImage: async (request) => {
        if (!disclosure.access.allowProviderBytes || input.purpose !== 'main') {
          throw new Error('Protected attachment request cannot generate image output')
        }
        return source.generateImage!(cloneAndFreezeRequest(request))
      },
    }),
    ...(source.submitVideo === undefined ? {} : {
      submitVideo: async (request) => {
        if (!disclosure.access.allowProviderBytes || input.purpose !== 'main') {
          throw new Error('Protected attachment request cannot submit video output')
        }
        return source.submitVideo!(cloneAndFreezeRequest(request))
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
  protectedSnapshots.set(protectedSnapshot, { disclosure, purpose: input.purpose })
  return protectedSnapshot
}

export function assertProtectedProviderSnapshot(
  snapshot: ModelProviderSnapshot,
  disclosure: ProviderAttachmentDisclosure | undefined,
  binding: AttachmentDisclosureBinding & { purpose: ProviderAttachmentPurpose },
): void {
  const protectedBinding = protectedSnapshots.get(snapshot)
  if (!disclosure
    || protectedBinding?.disclosure !== disclosure
    || protectedBinding.purpose !== binding.purpose) {
    throw new Error('Provider snapshot is not bound to the attachment disclosure capability')
  }
  assertIssued(disclosure, binding)
  if (snapshot.providerId !== binding.providerId) {
    throw new Error('Provider snapshot does not match the attachment disclosure capability')
  }
}
