import { createHash } from 'node:crypto'
import {
  type ConversionTargetFormat,
  type ModelProviderId,
} from '@autoforge/shared'
import type { ModelMediaInput } from '../media/media-asset-service.js'
import {
  providerAttachmentAccess,
  type ProviderAttachmentAccessContext,
  type ProviderAttachmentAccessDecision,
} from './attachment-conversion-policy.js'
import { projectAttachmentInputs } from './file-attachment-projection.js'
import {
  anonymizeAttachmentNames,
  classifyAttachmentConversionRequest,
  projectLocalConversionPrompt,
  type LocalAttachmentProjection,
} from './local-conversion-intent.js'
import type {
  ModelContentPart,
  ModelImageRequest,
  ModelMessage,
  ModelProvider,
  ModelProviderSnapshot,
  ModelStreamEvent,
  ModelStreamRequest,
  ModelVideoRequest,
} from './model-provider.js'

export type ProviderAttachmentPurpose = 'main' | 'title' | 'summary'
export type ProviderMediaPurpose = 'image' | 'video'

export interface ProviderAttachmentSafeText {
  readonly text: string
}

export interface ProviderAttachmentProjection {
  readonly content: string | ModelContentPart[]
}

export interface ProviderMediaProjection {
  readonly prompt: string
  readonly references: Array<{ mimeType: string; dataBase64: string }>
}

export interface AttachmentPrivacyPlan {
  readonly requestId: string
  readonly access: ProviderAttachmentAccessDecision
  readonly assetIds: readonly string[]
  readonly assetFingerprints: readonly string[]
  readonly forbiddenValues: readonly string[]
  readonly mainText: string
  readonly titleText: string
  readonly targetFormat?: ConversionTargetFormat
}

export interface ProviderAttachmentDisclosure extends AttachmentPrivacyPlan {
  readonly providerId: ModelProviderId
  readonly credentialEpoch: number
  readonly mainSafeText: ProviderAttachmentSafeText
  readonly titleSafeText: ProviderAttachmentSafeText
}

export interface AttachmentDisclosurePlanAsset extends LocalAttachmentProjection {
  readonly id: string
  readonly fingerprint: string
  readonly forbiddenValues?: readonly string[]
}

export interface CreateAttachmentDisclosurePlanInput {
  readonly requestId: string
  readonly text: string
  readonly context: ProviderAttachmentAccessContext
  readonly attachments: readonly AttachmentDisclosurePlanAsset[]
}

export interface ProviderAttachmentDisclosureAuthority {
  createPlan(input: CreateAttachmentDisclosurePlanInput): AttachmentPrivacyPlan
  bindProvider(
    plan: AttachmentPrivacyPlan,
    providerSnapshot: ModelProviderSnapshot,
  ): ProviderAttachmentDisclosure
  revokeProvider(providerId: ModelProviderId): void
  release(disclosure: ProviderAttachmentDisclosure): void
  activeCount(providerId?: ModelProviderId): number
}

interface PrivacyPlanAuthority {
  readonly originalText: string
  readonly originalTextHash: string
  readonly attachments: readonly AttachmentDisclosurePlanAsset[]
  readonly attachmentKinds: readonly ProviderAttachmentAccessContext['attachmentKinds'][number][]
  readonly requestedOutput: ProviderAttachmentAccessContext['requestedOutput']
}

interface DisclosureAuthority extends PrivacyPlanAuthority {
  readonly snapshot: ModelProviderSnapshot
  readonly apiKeyFingerprint?: string
  readonly currentCredentialEpoch: () => number
  readonly credentialProtected: boolean
  readonly revocation: AbortController
  readonly mediaProjectionReferences: Set<object>
}

interface AttachmentDisclosureBinding {
  requestId: string
  providerId: ModelProviderId
  assetIds: readonly string[]
  assetFingerprints: readonly string[]
}

interface ProtectedSnapshotBinding {
  readonly disclosure: ProviderAttachmentDisclosure
  readonly purpose: ProviderAttachmentPurpose
}

const issuedDisclosures = new WeakSet<object>()
const issuedPrivacyPlans = new WeakSet<object>()
const privacyPlanAuthorities = new WeakMap<object, PrivacyPlanAuthority>()
const disclosureAuthorities = new WeakMap<object, DisclosureAuthority>()
const issuedSafeTexts = new WeakMap<object, {
  disclosure: ProviderAttachmentDisclosure
  purpose: ProviderAttachmentPurpose
}>()
const disclosureProjectionPayloads = new WeakMap<object, Set<string>>()
const issuedMediaProjectionReferences = new WeakMap<object, {
  disclosure: ProviderAttachmentDisclosure
  purpose: ProviderMediaPurpose
  prompt: string
  references: readonly { mimeType: string; dataBase64: string; fingerprint: string; kind: 'image' }[]
}>()
const protectedSnapshots = new WeakMap<object, ProtectedSnapshotBinding>()
interface CanonicalLocalConversionIntent {
  readonly attachmentCount: number
  readonly attachmentIndexes: readonly number[]
  readonly targetFormat: ConversionTargetFormat
}

function canonicalLocalConversionIntent(
  attachments: readonly AttachmentDisclosurePlanAsset[],
  targetFormat: ConversionTargetFormat,
): CanonicalLocalConversionIntent {
  return Object.freeze({
    attachmentCount: attachments.length,
    attachmentIndexes: Object.freeze(attachments.map(({ index }) => index)),
    targetFormat,
  })
}

function canonicalLocalProviderText(intent: CanonicalLocalConversionIntent): {
  mainText: string
  titleText: string
} {
  const mainText = [
    '任务：选择并调用具备 file.convert 能力的本地工作流。',
    `附件数量：${intent.attachmentCount}`,
    `附件索引：${intent.attachmentIndexes.join(', ')}`,
    `目标格式：${intent.targetFormat}`,
    '禁止读取附件内容或调用非 file.convert 工具。',
  ].join('\n')
  const titleText = `本地文件转换 · ${intent.attachmentCount} 个附件 · ${intent.targetFormat.toUpperCase()}`
  return Object.freeze({ mainText, titleText })
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertLive(disclosure: ProviderAttachmentDisclosure): DisclosureAuthority {
  const authority = disclosureAuthorities.get(disclosure)
  if (!authority || (authority.credentialProtected && (
    authority.revocation.signal.aborted
    || authority.currentCredentialEpoch() !== disclosure.credentialEpoch
  ))) {
    throw new Error('Attachment disclosure capability has been revoked')
  }
  return authority
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
  assertLive(disclosure)
}

function issueSafeText(
  disclosure: ProviderAttachmentDisclosure,
  purpose: ProviderAttachmentPurpose,
  text: string,
): ProviderAttachmentSafeText {
  const safeText = Object.freeze({ text })
  issuedSafeTexts.set(safeText, { disclosure, purpose })
  return safeText
}

export function createProviderAttachmentDisclosureAuthority(input: {
  currentCredentialEpoch(providerId: ModelProviderId): number
  isCredentialTransitionActive?(providerId: ModelProviderId): boolean
}): ProviderAttachmentDisclosureAuthority {
  const active = new Map<ModelProviderId, Set<ProviderAttachmentDisclosure>>()
  const authority: ProviderAttachmentDisclosureAuthority = {
    createPlan(value: CreateAttachmentDisclosurePlanInput) {
      const hasAttachments = value.attachments.length > 0
      if (value.context.hasAttachments !== hasAttachments
        || value.context.attachmentKinds.length !== value.attachments.length
        || value.attachments.some((attachment, index) => (
          attachment.index !== index || !attachment.id || !/^[a-f0-9]{64}$/u.test(attachment.fingerprint)
        ))
        || new Set(value.attachments.map(({ id }) => id)).size !== value.attachments.length) {
        throw new Error('Attachment disclosure plan input is inconsistent')
      }
      const normalizedText = value.text.normalize('NFKC')
      const attachments = Object.freeze(value.attachments.map((attachment) => Object.freeze({
        ...attachment,
        forbiddenValues: Object.freeze([...(attachment.forbiddenValues ?? [])]),
      })))
      const projections = attachments.map(({ index, name, mimeType, byteSize }) => ({
        index, name, mimeType, byteSize,
      }))
      const classification = classifyAttachmentConversionRequest(normalizedText, projections)
      const access = providerAttachmentAccess(
        classification.decision,
        normalizedText,
        value.context,
      )
      if (access.decision === 'local' && classification.targetFormat === undefined) {
        throw new Error('Local conversion target authority is missing')
      }
      const providerText = access.decision === 'local'
        ? canonicalLocalProviderText(canonicalLocalConversionIntent(
            attachments,
            classification.targetFormat!,
          ))
        : {
            mainText: projectLocalConversionPrompt(normalizedText, projections),
            titleText: `用户：${anonymizeAttachmentNames(normalizedText, projections)}`,
          }
      const plan = Object.freeze({
        requestId: value.requestId,
        access,
        assetIds: Object.freeze(attachments.map(({ id }) => id)),
        assetFingerprints: Object.freeze(attachments.map(({ fingerprint }) => fingerprint)),
        forbiddenValues: Object.freeze([...new Set<string>(attachments.flatMap((attachment) => [
          attachment.name,
          attachment.id,
          attachment.fingerprint,
          ...(attachment.forbiddenValues ?? []),
        ]).filter(Boolean))]),
        mainText: providerText.mainText,
        titleText: providerText.titleText,
        ...(access.decision === 'local' ? { targetFormat: classification.targetFormat } : {}),
      })
      issuedPrivacyPlans.add(plan)
      privacyPlanAuthorities.set(plan, {
        originalText: normalizedText,
        originalTextHash: sha256(normalizedText),
        attachments,
        attachmentKinds: Object.freeze([...value.context.attachmentKinds]),
        requestedOutput: value.context.requestedOutput,
      })
      return plan
    },
    bindProvider(plan: AttachmentPrivacyPlan, providerSnapshot: ModelProviderSnapshot) {
      const planAuthority = privacyPlanAuthorities.get(plan)
      if (!issuedPrivacyPlans.has(plan) || !planAuthority || plan.access.decision === 'ambiguous') {
        throw new Error('Attachment privacy plan cannot be bound to a Provider')
      }
      if (input.isCredentialTransitionActive?.(providerSnapshot.providerId) === true) {
        throw new Error('Attachment disclosure cannot bind during a credential transition')
      }
      const credentialEpoch = input.currentCredentialEpoch(providerSnapshot.providerId)
      if (!Number.isSafeInteger(credentialEpoch) || credentialEpoch < 0) {
        throw new Error('Attachment disclosure credential epoch is invalid')
      }
      const publicValue = {
        ...plan,
        providerId: providerSnapshot.providerId,
        credentialEpoch,
      }
      const disclosure = publicValue as ProviderAttachmentDisclosure
      const mainSafeText = issueSafeText(disclosure, 'main', plan.mainText)
      const titleSafeText = issueSafeText(disclosure, 'title', plan.titleText)
      Object.assign(publicValue, { mainSafeText, titleSafeText })
      Object.freeze(publicValue)
      issuedDisclosures.add(disclosure)
      const revocation = new AbortController()
      disclosureAuthorities.set(disclosure, {
        ...planAuthority,
        snapshot: providerSnapshot,
        ...(providerSnapshot.apiKeyFingerprint === undefined
          ? {}
          : { apiKeyFingerprint: providerSnapshot.apiKeyFingerprint }),
        currentCredentialEpoch: () => input.currentCredentialEpoch(providerSnapshot.providerId),
        credentialProtected: planAuthority.attachments.length > 0,
        revocation,
        mediaProjectionReferences: new Set(),
      })
      disclosureProjectionPayloads.set(disclosure, new Set())
      if (planAuthority.attachments.length > 0) {
        const providerPlans = active.get(disclosure.providerId) ?? new Set()
        providerPlans.add(disclosure)
        active.set(disclosure.providerId, providerPlans)
      }
      return disclosure
    },
    revokeProvider(providerId: ModelProviderId) {
      const plans = active.get(providerId)
      if (!plans) return
      active.delete(providerId)
      for (const disclosure of plans) disclosureAuthorities.get(disclosure)?.revocation.abort()
    },
    release(disclosure: ProviderAttachmentDisclosure) {
      const disclosureAuthority = disclosureAuthorities.get(disclosure)
      if (!disclosureAuthority) return
      disclosureAuthority.revocation.abort()
      active.get(disclosure.providerId)?.delete(disclosure)
      if (active.get(disclosure.providerId)?.size === 0) active.delete(disclosure.providerId)
      for (const references of disclosureAuthority.mediaProjectionReferences) {
        issuedMediaProjectionReferences.delete(references)
      }
      issuedSafeTexts.delete(disclosure.mainSafeText)
      issuedSafeTexts.delete(disclosure.titleSafeText)
      disclosureProjectionPayloads.delete(disclosure)
      disclosureAuthorities.delete(disclosure)
      issuedDisclosures.delete(disclosure)
    },
    activeCount(providerId?: ModelProviderId) {
      if (providerId !== undefined) return active.get(providerId)?.size ?? 0
      return [...active.values()].reduce((count, values) => count + values.size, 0)
    },
  }
  return Object.freeze(authority)
}

function decodeCanonicalBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Attachment projection contains invalid Base64')
  return bytes
}

function assertInputsMatchPlan(
  disclosure: ProviderAttachmentDisclosure,
  inputs: readonly ModelMediaInput[],
): void {
  const authority = assertLive(disclosure)
  if (inputs.length !== authority.attachments.length || inputs.some((mediaInput, index) => {
    const attachment = authority.attachments[index]
    return attachment === undefined
      || mediaInput.assetId !== attachment.id
      || mediaInput.name.normalize('NFKC') !== attachment.name.normalize('NFKC')
      || mediaInput.mimeType !== attachment.mimeType
      || mediaInput.kind !== authority.attachmentKinds[index]
  })) {
    throw new Error('Attachment projection metadata does not match the request')
  }
  assertAttachmentByteAccess(disclosure, {
    requestId: disclosure.requestId,
    providerId: disclosure.providerId,
    assetIds: inputs.map(({ assetId }) => assetId),
    assetFingerprints: inputs.map(({ dataBase64 }) => sha256(decodeCanonicalBase64(dataBase64))),
  })
}

export function createProviderAttachmentProjection(
  disclosure: ProviderAttachmentDisclosure,
  provider: ModelProviderId,
  inputs: readonly ModelMediaInput[],
): ProviderAttachmentProjection {
  const authority = assertLive(disclosure)
  if (provider !== disclosure.providerId || sha256(authority.originalText) !== authority.originalTextHash) {
    throw new Error('Attachment projection plan does not match the request')
  }
  assertInputsMatchPlan(disclosure, inputs)
  const projected = projectAttachmentInputs(provider, inputs)
  const content: string | ModelContentPart[] = projected.length === 0
    ? authority.originalText
    : [
        ...(authority.originalText ? [{ type: 'text' as const, text: authority.originalText }] : []),
        ...projected,
      ]
  deepFreezeRequestValue(content)
  const projection = Object.freeze({ content })
  disclosureProjectionPayloads.get(disclosure)!.add(JSON.stringify(content))
  return projection
}

export function createProviderMediaProjection(
  disclosure: ProviderAttachmentDisclosure,
  provider: ModelProviderId,
  purpose: ProviderMediaPurpose,
  prompt: string,
  inputs: readonly ModelMediaInput[],
): ProviderMediaProjection {
  const authority = assertLive(disclosure)
  if (provider !== disclosure.providerId
    || (authority.requestedOutput !== purpose && authority.requestedOutput !== 'auto')
    || prompt.normalize('NFKC') !== authority.originalText
    || inputs.some(({ kind }) => kind !== 'image')) {
    throw new Error('Media projection plan does not match the request')
  }
  assertInputsMatchPlan(disclosure, inputs)
  const references = inputs.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 }))
  deepFreezeRequestValue(references)
  const projection = Object.freeze({ prompt: authority.originalText, references })
  issuedMediaProjectionReferences.set(references, {
    disclosure,
    purpose,
    prompt: authority.originalText,
    references: Object.freeze(inputs.map(({ kind, mimeType, dataBase64 }) => Object.freeze({
      kind: kind as 'image', mimeType, dataBase64, fingerprint: sha256(decodeCanonicalBase64(dataBase64)),
    }))),
  })
  authority.mediaProjectionReferences.add(references)
  return projection
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

function deepFreezeRequestValue(value: unknown, signal?: AbortSignal): void {
  if (!value || typeof value !== 'object' || value === signal || Object.isFrozen(value)) return
  for (const child of Object.values(value)) deepFreezeRequestValue(child, signal)
  Object.freeze(value)
}

function combinedSignal(signal: AbortSignal | undefined, revocation: AbortSignal): AbortSignal {
  return signal === undefined ? revocation : AbortSignal.any([signal, revocation])
}

function cloneAndFreezeRequest<T extends ModelStreamRequest | ModelImageRequest | ModelVideoRequest>(
  request: T,
  revocation: AbortSignal,
): T {
  const { signal, ...cloneable } = request
  const outbound = {
    ...structuredClone(cloneable),
    signal: combinedSignal(signal, revocation),
  } as T
  deepFreezeRequestValue(outbound, outbound.signal)
  return outbound
}

function assertSafeText(
  disclosure: ProviderAttachmentDisclosure,
  purpose: ProviderAttachmentPurpose,
  request: ModelStreamRequest,
): void {
  const safeText = purpose === 'main' ? disclosure.mainSafeText : disclosure.titleSafeText
  const binding = issuedSafeTexts.get(safeText)
  if (binding?.disclosure !== disclosure || binding.purpose !== purpose) {
    throw new Error('Protected attachment request is missing signed text')
  }
  const userMessages = request.messages.filter(({ role }) => role === 'user')
  if (userMessages.length !== 1 || userMessages[0]?.content !== safeText.text) {
    throw new Error('Protected attachment request contains unsigned user text')
  }
}

function hasStructuredAttachment(message: ModelMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type !== 'text')
}

function assertOrdinaryProjection(
  disclosure: ProviderAttachmentDisclosure,
  request: ModelStreamRequest,
): void {
  if (disclosure.assetIds.length === 0) return
  const userMessages = request.messages.filter(({ role }) => role === 'user')
  const current = userMessages.at(-1)
  const payload = JSON.stringify(current?.content)
  if (!current || !disclosureProjectionPayloads.get(disclosure)?.has(payload)) {
    throw new Error('Provider attachment projection is missing or invalid')
  }
  if (request.messages.some((message) => message !== current && hasStructuredAttachment(message))) {
    throw new Error('Provider request contains an unsigned attachment projection')
  }
}

function assertSafeStreamRequest(
  disclosure: ProviderAttachmentDisclosure,
  purpose: ProviderAttachmentPurpose,
  request: ModelStreamRequest,
): void {
  assertLive(disclosure)
  if (purpose === 'title') {
    assertSafeText(disclosure, purpose, request)
    if (request.output?.type === 'audio'
      || (request.tools?.length ?? 0) > 0
      || request.toolChoice !== undefined
      || request.messages.some(hasStructuredAttachment)) {
      throw new Error('Attachment title request must be text-only')
    }
    return
  }
  if (purpose === 'summary') {
    if (request.output?.type === 'audio'
      || (request.tools?.length ?? 0) > 0
      || request.toolChoice !== undefined
      || request.messages.some(hasStructuredAttachment)) {
      throw new Error('Attachment summary request must be text-only')
    }
    return
  }
  if (disclosure.access.decision === 'ordinary') {
    if (purpose === 'main') assertOrdinaryProjection(disclosure, request)
    return
  }
  assertSafeText(disclosure, purpose, request)
  if (request.output?.type === 'audio') throw new Error('Protected attachment request must be text-only')
  if (disclosure.access.decision === 'ambiguous'
    && ((request.tools?.length ?? 0) > 0 || request.toolChoice !== undefined)) {
    throw new Error('Ambiguous attachment request cannot expose tools')
  }
  for (const message of request.messages) {
    if (hasStructuredAttachment(message)) {
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

function assertIssuedMediaProjection(
  disclosure: ProviderAttachmentDisclosure,
  purpose: ProviderMediaPurpose,
  prompt: string,
  references: Array<{ mimeType: string; dataBase64: string }>,
): void {
  const binding = issuedMediaProjectionReferences.get(references)
  if (!binding
    || binding.disclosure !== disclosure
    || binding.purpose !== purpose
    || binding.prompt !== prompt
    || binding.references.length !== references.length
    || binding.references.some((reference, index) => (
      reference.kind !== 'image'
      || reference.mimeType !== references[index]?.mimeType
      || reference.dataBase64 !== references[index]?.dataBase64
      || reference.fingerprint !== sha256(decodeCanonicalBase64(references[index]!.dataBase64))
    ))) {
    throw new Error('Provider media request is missing an issued projection')
  }
}

function assertReferenceHashes(
  disclosure: ProviderAttachmentDisclosure,
  references: readonly { dataBase64: string }[],
): void {
  assertAttachmentByteAccess(disclosure, {
    requestId: disclosure.requestId,
    providerId: disclosure.providerId,
    assetIds: disclosure.assetIds,
    assetFingerprints: references.map(({ dataBase64 }) => sha256(decodeCanonicalBase64(dataBase64))),
  })
}

function deferredProtectedStream(
  source: ModelProvider,
  disclosure: ProviderAttachmentDisclosure,
  outbound: ModelStreamRequest,
): AsyncIterable<ModelStreamEvent> {
  return {
    [Symbol.asyncIterator]() {
      let iterator: AsyncIterator<ModelStreamEvent> | undefined
      return {
        async next() {
          assertLive(disclosure)
          if (outbound.signal?.aborted) throw new Error('Attachment disclosure capability has been revoked')
          iterator ??= source.stream(outbound)[Symbol.asyncIterator]()
          const result = await iterator.next()
          assertLive(disclosure)
          return result
        },
        async return() {
          return iterator?.return === undefined
            ? { done: true, value: undefined }
            : await iterator.return()
        },
      }
    },
  }
}

export function protectProviderSnapshot(
  snapshot: ModelProviderSnapshot,
  disclosure: ProviderAttachmentDisclosure,
  input: { purpose: ProviderAttachmentPurpose },
): ModelProviderSnapshot {
  assertIssued(disclosure, {
    requestId: disclosure.requestId,
    providerId: snapshot.providerId,
    assetIds: disclosure.assetIds,
    assetFingerprints: disclosure.assetFingerprints,
  })
  const authority = assertLive(disclosure)
  if (input.purpose === 'summary' && disclosure.access.decision === 'local') {
    throw new Error('Local conversion disclosure cannot issue a summary capability')
  }
  if (authority.snapshot !== snapshot
    || authority.apiKeyFingerprint !== snapshot.apiKeyFingerprint) {
    throw new Error('Provider snapshot does not match the attachment disclosure capability')
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
      const outbound = cloneAndFreezeRequest(request, authority.revocation.signal)
      assertSafeStreamRequest(disclosure, input.purpose, outbound)
      if (input.purpose === 'title') titleUsed = true
      return deferredProtectedStream(source, disclosure, outbound)
    },
    ...(source.generateImage === undefined ? {} : {
      generateImage: async (request) => {
        if (!disclosure.access.allowProviderBytes || input.purpose !== 'main') {
          throw new Error('Protected attachment request cannot generate image output')
        }
        assertIssuedMediaProjection(disclosure, 'image', request.prompt, request.references)
        const outbound = cloneAndFreezeRequest(request, authority.revocation.signal)
        assertReferenceHashes(disclosure, outbound.references)
        const result = await source.generateImage!(outbound)
        assertLive(disclosure)
        return result
      },
    }),
    ...(source.submitVideo === undefined ? {} : {
      submitVideo: async (request) => {
        if (!disclosure.access.allowProviderBytes || input.purpose !== 'main') {
          throw new Error('Protected attachment request cannot submit video output')
        }
        assertIssuedMediaProjection(disclosure, 'video', request.prompt, request.references)
        const outbound = cloneAndFreezeRequest(request, authority.revocation.signal)
        assertReferenceHashes(disclosure, outbound.references)
        const result = await source.submitVideo!(outbound)
        assertLive(disclosure)
        return result
      },
    }),
    ...(source.pollVideo === undefined ? {} : { pollVideo: source.pollVideo.bind(source) }),
    ...(source.downloadVideo === undefined ? {} : { downloadVideo: source.downloadVideo.bind(source) }),
    ...(source.getGenerationUsage === undefined ? {} : {
      getGenerationUsage: source.getGenerationUsage.bind(source),
    }),
  }
  const protectedSnapshot = Object.freeze({ ...snapshot, provider: Object.freeze(provider) })
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
