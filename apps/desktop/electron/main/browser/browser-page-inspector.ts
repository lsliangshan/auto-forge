import { createHash, randomUUID } from 'node:crypto'
import {
  matchesHttpsUrlPattern,
  toSafeAppError,
  type AppError,
  type AppErrorCode,
} from '@autoforge/shared'
import type {
  BrowserContinuationBinding,
  BrowserContinuationLease,
  BrowserActionTargetContext,
  BrowserPageSnapshot,
  BrowserRegionImage,
  BrowserSemanticNode,
} from './browser-continuation-types.js'

export interface BrowserInspectionDomSummary {
  readonly tagName: string
  readonly inputType?: string
  readonly autocomplete?: string
  readonly hidden?: boolean
  readonly readOnly?: boolean
  readonly contentEditable?: boolean
}

export interface BrowserInspectionNode {
  readonly axNodeId: string
  readonly parentAxNodeId: string | undefined
  readonly backendNodeId: number
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly enabled: boolean
  readonly checked?: boolean
  readonly selected?: boolean
  readonly ignored: boolean
  readonly frameId: string | undefined
  readonly scrollable?: boolean
  readonly dom: BrowserInspectionDomSummary
}

export interface BrowserPageReadResult {
  readonly tabId: string
  readonly navigationEpoch: number
  readonly origin: string
  readonly url: string
  readonly title: string
  readonly frameId: string
  readonly viewportWidth: number
  readonly viewportHeight: number
  readonly nodes: readonly BrowserInspectionNode[]
  readonly locatorMatches: readonly {
    readonly locator: string
    readonly backendNodeIds: readonly number[]
  }[]
}

interface BrowserPageReadInput {
  readonly tabId: string
  readonly runId: string
  readonly expectedOrigin: string
  readonly expectedNavigationEpoch: number
  readonly locators: readonly string[]
}

interface BrowserNodeReadInput {
  readonly tabId: string
  readonly runId: string
  readonly expectedOrigin: string
  readonly expectedNavigationEpoch: number
  readonly backendNodeId: number
}

export interface BrowserInspectionNodeBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly viewportWidth: number
  readonly viewportHeight: number
}

interface BrowserNodeScreenshotInput extends BrowserNodeReadInput {
  readonly clip: Pick<BrowserInspectionNodeBox, 'x' | 'y' | 'width' | 'height'>
  readonly expectedRole: string
  readonly expectedName: string
  readonly expectedTagName: string
  readonly expectedInputType?: string
}

export interface BrowserPageCdpPort {
  readAccessibilitySnapshot(input: BrowserPageReadInput): Promise<BrowserPageReadResult>
  readNode(input: BrowserNodeReadInput): Promise<BrowserInspectionNode | undefined>
  getNodeBox(input: BrowserNodeReadInput): Promise<BrowserInspectionNodeBox>
  captureNodeScreenshot(input: BrowserNodeScreenshotInput): Promise<string>
  onPageInvalidated(listener: (tabId: string) => void): () => void
}

export interface BrowserPageInspectInput {
  readonly lease: BrowserContinuationLease
  readonly tabId: string
  readonly navigationEpoch: number
  readonly origin: string
  readonly intent: string
  readonly mode?: 'semantic' | 'region_image'
  readonly ref?: string
  readonly cursor?: string
  readonly visionSupported?: boolean
}

export interface BrowserRefResolutionInput {
  readonly lease: BrowserContinuationLease
  readonly tabId: string
  readonly snapshotId: string
  readonly navigationEpoch: number
  readonly origin: string
  readonly ref: string
}

export interface BrowserPageContextInput {
  readonly lease: BrowserContinuationLease
  readonly tabId: string
  readonly navigationEpoch: number
  readonly origin: string
}

export interface BrowserLivePageContext {
  readonly auth: BrowserPageSnapshot['auth']
  readonly semanticFingerprint: string
}

export interface BrowserResolvedElementReference {
  readonly snapshotId: string
  readonly ref: string
  readonly backendNodeId: number
  readonly role: string
  readonly name: string
  readonly auth: BrowserPageSnapshot['auth']
  readonly semanticFingerprint: string
  readonly targetContext: BrowserActionTargetContext
}

interface InspectorOptions {
  readonly id?: () => string
  readonly now?: () => number
}

interface SafeCandidate {
  readonly backendNodeId: number
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly enabled: boolean
  readonly checked?: boolean
  readonly selected?: boolean
  readonly actions: BrowserSemanticNode['actions']
  readonly imageRestricted: boolean
  readonly tagName: string
  readonly inputType?: string
}

interface SnapshotIdentity {
  readonly runId: string
  readonly bindingId: string
  readonly tabId: string
  readonly snapshotId: string
  readonly navigationEpoch: number
  readonly origin: string
}

interface RefState extends SnapshotIdentity, SafeCandidate {
  readonly ref: string
}

interface CursorState extends SnapshotIdentity {
  readonly cursor: string
  readonly url: string
  readonly title: string
  readonly capturedAt: string
  readonly auth: BrowserPageSnapshot['auth']
  readonly candidates: readonly SafeCandidate[]
  readonly nextIndex: number
}

const maxSerializedBytes = 128 * 1024
const maxSemanticNodes = 500
const maxImagePixels = 1_000_000
const maxTextLength = 512

const semanticRoles = new Set([
  'article', 'banner', 'button', 'cell', 'checkbox', 'combobox', 'complementary', 'contentinfo',
  'dialog', 'document', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list',
  'listbox', 'listitem', 'main', 'menu', 'menuitem', 'navigation', 'option', 'paragraph', 'radio',
  'region', 'row', 'rowheader', 'search', 'searchbox', 'slider', 'spinbutton', 'statictext', 'status',
  'switch', 'tab', 'table', 'tabpanel', 'textbox', 'tree', 'treeitem',
])
const fillRoles = new Set(['searchbox', 'spinbutton', 'textbox'])
const selectRoles = new Set(['combobox', 'listbox'])
const clickRoles = new Set(['button', 'link', 'menuitem', 'option', 'tab', 'treeitem'])
const checkRoles = new Set(['checkbox', 'radio', 'switch'])
const valueRoles = new Set([...fillRoles, ...selectRoles, 'meter', 'progressbar', 'slider'])
const authenticationText = /(?:captcha|one[ -]?time|verification code|动态码|短信码|校验码|验证码)/iu
const loginText = /(?:^|\s)(?:log[ -]?in|sign[ -]?in)(?:\s|$)|登录|登陆/iu
const paymentText = /(?:payment|credit card|debit card|银行卡|信用卡|借记卡|支付|付款)/iu
const signatureText = /(?:signature|签名|签字)/iu
const secretText = /(?:authorization|bearer|cookie|session[-_ ]?(?:id|key|secret|token)?|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|hidden[-_ ]?token|client[-_ ]?secret)/iu
const chineseIdentity = /\b\d{17}[\dXx]\b|\b\d{15}\b/u
const longPrivateNumber = /\b\d{8,}\b/u
const safeDate = /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?$/u
const emailAddress = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu
const filesystemPath = /(?:\bfile\s*:|\b(?:file|folder|directory)path\s*[:=]|(?:^|[\s="'(:])\/(?:[^\s/]+\/)*[^\s/]+|\b[A-Za-z]:[\\/]|(?:^|[\s="'(])\\\\[^\\/\s]+[\\/][^\\/\s]+)/iu

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function normalizedRole(value: string): string {
  const role = value.replaceAll(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  if (role === 'static-text' || role === 'inline-text-box') return 'statictext'
  return role
}

function normalizedText(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('').replaceAll(/\s+/g, ' ').trim()
}

function sensitiveText(value: string): boolean {
  let candidate = value
  for (let depth = 0; depth < 3; depth += 1) {
    if (secretText.test(candidate)
      || chineseIdentity.test(candidate)
      || emailAddress.test(candidate)
      || uuid.test(candidate)
      || filesystemPath.test(candidate)
      || (!safeDate.test(candidate) && longPrivateNumber.test(candidate))) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) break
      candidate = decoded
    } catch {
      break
    }
  }
  return false
}

function safeText(value: string): string | undefined {
  const normalized = normalizedText(value).slice(0, maxTextLength)
  if (!normalized || sensitiveText(normalized)) return undefined
  return normalized
}

function safeUrl(value: string, expectedOrigin: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.origin !== expectedOrigin) return expectedOrigin
    return expectedOrigin
  } catch {
    return expectedOrigin
  }
}

function authNode(node: BrowserInspectionNode): boolean {
  const role = normalizedRole(node.role)
  const type = node.dom.inputType?.toLowerCase()
  const autocomplete = node.dom.autocomplete?.toLowerCase()
  return type === 'password'
    || autocomplete === 'one-time-code'
    || (['img', 'searchbox', 'textbox'].includes(role) && authenticationText.test(node.name))
}

function imageRestrictedNode(node: BrowserInspectionNode): boolean {
  const combined = `${node.name} ${node.dom.inputType ?? ''}`
  return authNode(node)
    || node.dom.inputType?.toLowerCase() === 'file'
    || paymentText.test(combined)
    || signatureText.test(combined)
}

function relevantValue(name: string, intent: string): boolean {
  const normalizedName = normalizedText(name).toLowerCase()
  const normalizedIntent = normalizedText(intent).toLowerCase()
  if (!normalizedName || !normalizedIntent) return false
  if (normalizedIntent.includes(normalizedName) || normalizedName.includes(normalizedIntent)) return true
  const terms = normalizedName.match(/[\p{L}\p{N}]{2,}/gu) ?? []
  if (terms.some((term) => normalizedIntent.includes(term))) return true
  for (let index = 0; index < normalizedName.length - 1; index += 1) {
    if (normalizedIntent.includes(normalizedName.slice(index, index + 2))) return true
  }
  return false
}

function hasPermission(
  binding: BrowserContinuationBinding,
  capability: 'browser.fill' | 'browser.click',
  pageUrl: string,
): boolean {
  return (binding.permissionMatrix[capability] ?? [])
    .some((pattern) => matchesHttpsUrlPattern(pattern, pageUrl))
}

function actionsFor(
  node: BrowserInspectionNode,
  role: string,
  binding: BrowserContinuationBinding,
  pageUrl: string,
): BrowserSemanticNode['actions'] {
  if (!node.enabled || node.dom.readOnly || imageRestrictedNode(node)) return Object.freeze([])
  const actions: Array<BrowserSemanticNode['actions'][number]> = []
  if (hasPermission(binding, 'browser.fill', pageUrl)) {
    if (fillRoles.has(role)) actions.push('fill')
    if (selectRoles.has(role)) actions.push('select')
  }
  if (hasPermission(binding, 'browser.click', pageUrl)) {
    if (clickRoles.has(role)) actions.push('click')
    if (checkRoles.has(role)) actions.push('check')
  }
  if (node.scrollable) actions.push('scroll')
  return Object.freeze(actions)
}

function fixedSerializedBytes(snapshot: Omit<BrowserPageSnapshot, 'serializedBytes'>): BrowserPageSnapshot {
  let serializedBytes = 0
  let result = Object.freeze({ ...snapshot, serializedBytes })
  let next = Buffer.byteLength(JSON.stringify(result), 'utf8')
  while (next !== serializedBytes) {
    serializedBytes = next
    result = Object.freeze({ ...snapshot, serializedBytes })
    next = Buffer.byteLength(JSON.stringify(result), 'utf8')
  }
  return result
}

export class BrowserPageInspector {
  private readonly id: () => string
  private readonly now: () => number
  private readonly refs = new Map<string, RefState>()
  private readonly cursors = new Map<string, CursorState>()
  private readonly unsubscribeInvalidation: () => void

  constructor(private readonly port: BrowserPageCdpPort, options: InspectorOptions = {}) {
    this.id = options.id ?? randomUUID
    this.now = options.now ?? Date.now
    this.unsubscribeInvalidation = port.onPageInvalidated((tabId) => { this.invalidateTab(tabId) })
  }

  inspect(input: BrowserPageInspectInput & { readonly mode: 'region_image' }): Promise<BrowserRegionImage>
  inspect(input: BrowserPageInspectInput & { readonly mode?: 'semantic' }): Promise<BrowserPageSnapshot>
  async inspect(input: BrowserPageInspectInput): Promise<BrowserPageSnapshot | BrowserRegionImage> {
    this.assertBinding(input)
    if (input.mode === 'region_image') return this.captureRegion(input)
    if (input.ref !== undefined) throw failure('INVALID_INPUT')
    if (input.cursor) return this.nextPage(input)
    return this.captureSemantic(input)
  }

  async resolveRef(input: BrowserRefResolutionInput): Promise<BrowserResolvedElementReference> {
    const binding = this.liveBinding(input.lease)
    const state = this.refs.get(input.ref)
    if (!state || !this.sameIdentity(state, {
      runId: input.lease.ownerRunId,
      bindingId: binding.bindingId,
      tabId: input.tabId,
      snapshotId: input.snapshotId,
      navigationEpoch: input.navigationEpoch,
      origin: input.origin,
    })) throw failure('PAGE_CHANGED')
    const { page, visibleNodes, auth, semanticFingerprint } = await this.readLivePageContext(input)
    const current = visibleNodes.find((node) => node.backendNodeId === state.backendNodeId)
    if (!current
      || current.ignored
      || current.dom.hidden
      || normalizedRole(current.role) !== state.role
      || safeText(current.name) !== state.name
      || current.dom.tagName.toLowerCase() !== state.tagName
      || current.dom.inputType?.toLowerCase() !== state.inputType
      || current.enabled !== state.enabled
      || current.checked !== state.checked
      || current.selected !== state.selected) {
      this.refs.delete(input.ref)
      throw failure('PAGE_CHANGED')
    }
    this.liveBinding(input.lease)
    return Object.freeze({
      snapshotId: state.snapshotId,
      ref: state.ref,
      backendNodeId: state.backendNodeId,
      role: state.role,
      name: state.name,
      auth,
      semanticFingerprint,
      targetContext: this.targetContext(binding, page, visibleNodes, current),
    })
  }

  async currentPageContext(input: BrowserPageContextInput): Promise<BrowserLivePageContext> {
    const { auth, semanticFingerprint } = await this.readLivePageContext(input)
    return Object.freeze({ auth, semanticFingerprint })
  }

  endRun(runId: string): void {
    for (const [ref, state] of this.refs) if (state.runId === runId) this.refs.delete(ref)
    for (const [cursor, state] of this.cursors) if (state.runId === runId) this.cursors.delete(cursor)
  }

  dispose(): void {
    this.unsubscribeInvalidation()
    this.refs.clear()
    this.cursors.clear()
  }

  private async captureSemantic(input: BrowserPageInspectInput): Promise<BrowserPageSnapshot> {
    const binding = this.liveBinding(input.lease)
    const runId = input.lease.ownerRunId
    const locators = this.policyLocators(binding)
    const page = await this.port.readAccessibilitySnapshot({
      tabId: input.tabId,
      runId,
      expectedOrigin: input.origin,
      expectedNavigationEpoch: input.navigationEpoch,
      locators,
    })
    this.liveBinding(input.lease)
    this.assertPage(input, page)
    const matchingPatterns = Object.values(binding.permissionMatrix).flat()
    if (!matchingPatterns.some((pattern) => matchesHttpsUrlPattern(pattern, page.url))) {
      throw failure('DOMAIN_BLOCKED')
    }

    const mainFrameNodes = page.nodes.filter((node) => node.frameId === undefined || node.frameId === page.frameId)
    const visibleNodes = mainFrameNodes.filter((node) => !node.ignored && !node.dom.hidden)
    const auth = this.classifyAuth(binding, page, visibleNodes)
    const readable = this.readableNodes(binding, page, mainFrameNodes, visibleNodes)
    const restrictedRegions = this.restrictedRegionBackendIds(mainFrameNodes, visibleNodes)
    const candidates = readable.flatMap((node): SafeCandidate[] => {
      const role = normalizedRole(node.role)
      if (!semanticRoles.has(role) || authNode(node)) return []
      const name = safeText(node.name)
      if (!name) return []
      const rawValue = node.value === undefined ? undefined : safeText(node.value)
      const value = valueRoles.has(role)
        && rawValue !== undefined
        && relevantValue(name, input.intent)
        && !imageRestrictedNode(node)
        ? rawValue
        : undefined
      return [{
        backendNodeId: node.backendNodeId,
        role,
        name,
        ...(value === undefined ? {} : { value }),
        enabled: node.enabled,
        ...(node.checked === undefined ? {} : { checked: node.checked }),
        ...(node.selected === undefined ? {} : { selected: node.selected }),
        actions: actionsFor(node, role, binding, page.url),
        imageRestricted: restrictedRegions.has(node.backendNodeId),
        tagName: node.dom.tagName.toLowerCase(),
        ...(node.dom.inputType === undefined ? {} : { inputType: node.dom.inputType.toLowerCase() }),
      }]
    })
    const snapshotId = this.opaque('snapshot')
    const capturedAt = new Date(this.now()).toISOString()
    return this.pageFromCandidates({
      runId,
      bindingId: binding.bindingId,
      tabId: input.tabId,
      snapshotId,
      navigationEpoch: input.navigationEpoch,
      origin: input.origin,
      url: safeUrl(page.url, input.origin),
      title: safeText(page.title) ?? '',
      capturedAt,
      auth,
      candidates,
      nextIndex: 0,
    })
  }

  private async nextPage(input: BrowserPageInspectInput): Promise<BrowserPageSnapshot> {
    const binding = this.liveBinding(input.lease)
    const runId = input.lease.ownerRunId
    const state = this.cursors.get(input.cursor!)
    if (!state || !this.sameIdentity(state, {
      runId,
      bindingId: binding.bindingId,
      tabId: input.tabId,
      snapshotId: state?.snapshotId ?? '',
      navigationEpoch: input.navigationEpoch,
      origin: input.origin,
    })) throw failure('PAGE_CHANGED')
    this.cursors.delete(state.cursor)
    const page = await this.port.readAccessibilitySnapshot({
      tabId: input.tabId,
      runId,
      expectedOrigin: input.origin,
      expectedNavigationEpoch: input.navigationEpoch,
      locators: this.policyLocators(binding),
    })
    this.liveBinding(input.lease)
    this.assertPage(input, page)
    return this.pageFromCandidates(state)
  }

  private pageFromCandidates(input: Omit<CursorState, 'cursor'>): BrowserPageSnapshot {
    const nodes: BrowserSemanticNode[] = []
    const acceptedRefs: RefState[] = []
    const possibleCursor = this.opaque('cursor')
    let nextIndex = input.nextIndex
    while (nextIndex < input.candidates.length && nodes.length < maxSemanticNodes) {
      const candidate = input.candidates[nextIndex]!
      const ref = this.opaque('ref')
      const semanticNode = Object.freeze({
        ref,
        role: candidate.role,
        name: candidate.name,
        ...(candidate.value === undefined ? {} : { value: candidate.value }),
        enabled: candidate.enabled,
        ...(candidate.checked === undefined ? {} : { checked: candidate.checked }),
        ...(candidate.selected === undefined ? {} : { selected: candidate.selected }),
        actions: candidate.actions,
      })
      const trialNodes = Object.freeze([...nodes, semanticNode])
      const hasMore = nextIndex + 1 < input.candidates.length
      const trial = fixedSerializedBytes({
        snapshotId: input.snapshotId,
        bindingId: input.bindingId,
        origin: input.origin,
        url: input.url,
        title: input.title,
        capturedAt: input.capturedAt,
        navigationEpoch: input.navigationEpoch,
        auth: input.auth,
        nodes: trialNodes,
        ...(hasMore ? { cursor: possibleCursor } : {}),
      })
      if (trial.serializedBytes > maxSerializedBytes) break
      nodes.push(semanticNode)
      acceptedRefs.push(Object.freeze({
        runId: input.runId,
        bindingId: input.bindingId,
        tabId: input.tabId,
        snapshotId: input.snapshotId,
        navigationEpoch: input.navigationEpoch,
        origin: input.origin,
        ...candidate,
        ref,
      }))
      nextIndex += 1
    }
    if (nodes.length === 0 && nextIndex < input.candidates.length) throw failure('UNSUPPORTED_CONTROL')
    for (const state of acceptedRefs) this.refs.set(state.ref, state)
    const hasMore = nextIndex < input.candidates.length
    if (hasMore) {
      this.cursors.set(possibleCursor, Object.freeze({ ...input, cursor: possibleCursor, nextIndex }))
    }
    return fixedSerializedBytes({
      snapshotId: input.snapshotId,
      bindingId: input.bindingId,
      origin: input.origin,
      url: input.url,
      title: input.title,
      capturedAt: input.capturedAt,
      navigationEpoch: input.navigationEpoch,
      auth: input.auth,
      nodes: Object.freeze(nodes),
      ...(hasMore ? { cursor: possibleCursor } : {}),
    })
  }

  private classifyAuth(
    binding: BrowserContinuationBinding,
    page: BrowserPageReadResult,
    visibleNodes: readonly BrowserInspectionNode[],
  ): BrowserPageSnapshot['auth'] {
    const matches = new Map(page.locatorMatches.map((entry) => [entry.locator, entry.backendNodeIds]))
    const visibleBackendIds = new Set(visibleNodes.map((node) => node.backendNodeId))
    const markerPresent = (locators: readonly string[] | undefined) => (locators ?? []).some(
      (locator) => (matches.get(locator) ?? []).some((id) => visibleBackendIds.has(id)),
    )
    const policy = binding.browserContinuation?.auth
    const configuredLoginUrl = (policy?.loginUrls ?? []).some((pattern) => matchesHttpsUrlPattern(pattern, page.url))
    let implicitLoginUrl = false
    try { implicitLoginUrl = /\/(?:login|signin|sign-in|userlogin)(?:\/|$)/iu.test(new URL(page.url).pathname) } catch { /* invalid page URLs fail elsewhere */ }
    const explicitLoggedOutNode = visibleNodes.some((node) => {
      const role = normalizedRole(node.role)
      return ['button', 'form', 'link'].includes(role) && loginText.test(node.name)
    })
    const required = configuredLoginUrl
      || implicitLoginUrl
      || markerPresent(policy?.loggedOut)
      || explicitLoggedOutNode
      || visibleNodes.some(authNode)
    const authenticated = markerPresent(policy?.loggedIn)
    if (required === authenticated) return 'unknown'
    return required ? 'required' : 'authenticated'
  }

  private readableNodes(
    binding: BrowserContinuationBinding,
    page: BrowserPageReadResult,
    mainFrameNodes: readonly BrowserInspectionNode[],
    visibleNodes: readonly BrowserInspectionNode[],
  ): readonly BrowserInspectionNode[] {
    const readableLocators = binding.browserContinuation?.readableRegions
    if (!readableLocators?.length) return visibleNodes
    const matches = new Map(page.locatorMatches.map((entry) => [entry.locator, entry.backendNodeIds]))
    const roots = new Set(readableLocators.flatMap((locator) => [...(matches.get(locator) ?? [])]))
    if (roots.size === 0) return []
    const byAxId = new Map(mainFrameNodes.map((node) => [node.axNodeId, node]))
    return visibleNodes.filter((node) => {
      let current: BrowserInspectionNode | undefined = node
      const seen = new Set<string>()
      while (current && !seen.has(current.axNodeId)) {
        if (roots.has(current.backendNodeId)) return true
        seen.add(current.axNodeId)
        current = current.parentAxNodeId ? byAxId.get(current.parentAxNodeId) : undefined
      }
      return false
    })
  }

  private async captureRegion(input: BrowserPageInspectInput): Promise<BrowserRegionImage> {
    if (!input.visionSupported || !input.ref || input.cursor) throw failure('UNSUPPORTED_CONTROL')
    const binding = this.liveBinding(input.lease)
    const runId = input.lease.ownerRunId
    const state = this.refs.get(input.ref)
    if (!state) throw failure('PAGE_CHANGED')
    const resolved = await this.resolveRef({
      lease: input.lease,
      tabId: input.tabId,
      snapshotId: state.snapshotId,
      navigationEpoch: input.navigationEpoch,
      origin: input.origin,
      ref: input.ref,
    })
    if (state.imageRestricted) throw failure('UNSUPPORTED_CONTROL')
    const page = await this.port.readAccessibilitySnapshot({
      tabId: input.tabId,
      runId,
      expectedOrigin: input.origin,
      expectedNavigationEpoch: input.navigationEpoch,
      locators: this.policyLocators(binding),
    })
    this.liveBinding(input.lease)
    this.assertPage(input, page)
    const patterns = Object.values(binding.permissionMatrix).flat()
    if (!patterns.some((pattern) => matchesHttpsUrlPattern(pattern, page.url))) throw failure('DOMAIN_BLOCKED')
    const mainFrameNodes = page.nodes.filter((node) => node.frameId === undefined || node.frameId === page.frameId)
    const visibleNodes = mainFrameNodes.filter((node) => !node.ignored && !node.dom.hidden)
    const current = visibleNodes.find((node) => node.backendNodeId === state.backendNodeId)
    const readable = this.readableNodes(binding, page, mainFrameNodes, visibleNodes)
    const readableIds = new Set(readable.map((node) => node.backendNodeId))
    if (!current
      || !readableIds.has(current.backendNodeId)
      || this.restrictedRegionBackendIds(mainFrameNodes, visibleNodes).has(current.backendNodeId)) {
      throw failure('UNSUPPORTED_CONTROL')
    }
    const box = await this.port.getNodeBox({
      tabId: state.tabId,
      runId: state.runId,
      expectedOrigin: state.origin,
      expectedNavigationEpoch: state.navigationEpoch,
      backendNodeId: state.backendNodeId,
    })
    this.liveBinding(input.lease)
    const values = [box.x, box.y, box.width, box.height, box.viewportWidth, box.viewportHeight]
    const fullPage = ['html', 'body'].includes(current.dom.tagName.toLowerCase())
      || normalizedRole(current.role) === 'document'
      || (box.x <= 0 && box.y <= 0
        && box.width >= box.viewportWidth && box.height >= box.viewportHeight)
    if (values.some((value) => !Number.isFinite(value))
      || box.width <= 0
      || box.height <= 0
      || box.x < 0
      || box.y < 0
      || box.x + box.width > box.viewportWidth
      || box.y + box.height > box.viewportHeight
      || box.width * box.height > maxImagePixels
      || fullPage) throw failure('UNSUPPORTED_CONTROL')
    const clip = Object.freeze({ x: box.x, y: box.y, width: box.width, height: box.height })
    const data = await this.port.captureNodeScreenshot({
      tabId: state.tabId,
      runId: state.runId,
      expectedOrigin: state.origin,
      expectedNavigationEpoch: state.navigationEpoch,
      backendNodeId: resolved.backendNodeId,
      clip,
      expectedRole: state.role,
      expectedName: state.name,
      expectedTagName: state.tagName,
      ...(state.inputType === undefined ? {} : { expectedInputType: state.inputType }),
    })
    this.liveBinding(input.lease)
    return Object.freeze({
      snapshotId: state.snapshotId,
      bindingId: state.bindingId,
      origin: state.origin,
      ref: state.ref,
      capturedAt: new Date(this.now()).toISOString(),
      mediaType: 'image/png',
      width: box.width,
      height: box.height,
      data,
    })
  }

  private assertBinding(input: BrowserPageInspectInput): void {
    const binding = this.liveBinding(input.lease)
    let exactOrigin: string | undefined
    try {
      const url = new URL(input.origin)
      if (url.protocol === 'https:') exactOrigin = url.origin
    } catch { /* rejected below as a safe invalid input */ }
    if (input.lease.ownerRunId.length === 0
      || binding.bindingId === ''
      || binding.tabId !== input.tabId
      || binding.status !== 'active'
      || input.intent.trim().length === 0
      || input.intent.length > 2_000
      || input.origin !== exactOrigin) throw failure('INVALID_INPUT')
  }

  private liveBinding(lease: BrowserContinuationLease): BrowserContinuationBinding {
    try {
      if (!lease.isCurrent(lease.binding)) throw failure('PAGE_CHANGED')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'PAGE_CHANGED') throw error
      throw failure('PAGE_CHANGED')
    }
    return lease.binding
  }

  private assertPage(input: BrowserPageInspectInput, page: BrowserPageReadResult): void {
    if (page.tabId !== input.tabId
      || page.origin !== input.origin
      || page.navigationEpoch !== input.navigationEpoch) throw failure('PAGE_CHANGED')
  }

  private policyLocators(binding: BrowserContinuationBinding): readonly string[] {
    const policy = binding.browserContinuation
    return Object.freeze([
      ...(policy?.auth?.loggedIn ?? []),
      ...(policy?.auth?.loggedOut ?? []),
      ...(policy?.readableRegions ?? []),
      ...(policy?.manualActions ?? []).map(({ locator }) => locator),
    ])
  }

  private async readLivePageContext(input: BrowserPageContextInput): Promise<{
    readonly page: BrowserPageReadResult
    readonly visibleNodes: readonly BrowserInspectionNode[]
    readonly auth: BrowserPageSnapshot['auth']
    readonly semanticFingerprint: string
  }> {
    const binding = this.liveBinding(input.lease)
    const page = await this.port.readAccessibilitySnapshot({
      tabId: input.tabId,
      runId: input.lease.ownerRunId,
      expectedOrigin: input.origin,
      expectedNavigationEpoch: input.navigationEpoch,
      locators: this.policyLocators(binding),
    })
    this.liveBinding(input.lease)
    this.assertPage({ ...input, intent: 'live action validation' }, page)
    const patterns = Object.values(binding.permissionMatrix).flat()
    if (!patterns.some((pattern) => matchesHttpsUrlPattern(pattern, page.url))) throw failure('DOMAIN_BLOCKED')
    const visibleNodes = page.nodes.filter((node) => (
      (node.frameId === undefined || node.frameId === page.frameId) && !node.ignored && !node.dom.hidden
    ))
    return Object.freeze({
      page,
      visibleNodes,
      auth: this.classifyAuth(binding, page, visibleNodes),
      semanticFingerprint: this.semanticFingerprint(page, visibleNodes),
    })
  }

  private semanticFingerprint(
    page: BrowserPageReadResult,
    visibleNodes: readonly BrowserInspectionNode[],
  ): string {
    const bounded = visibleNodes.slice(0, maxSemanticNodes).map((node) => ({
      role: normalizedRole(node.role),
      name: safeText(node.name) ?? '',
      value: node.value === undefined ? undefined : safeText(node.value),
      enabled: node.enabled,
      checked: node.checked,
      selected: node.selected,
      tagName: node.dom.tagName.toLowerCase(),
      inputType: node.dom.inputType?.toLowerCase(),
    }))
    return createHash('sha256').update(JSON.stringify({
      origin: page.origin, url: safeUrl(page.url, page.origin), nodes: bounded,
    })).digest('hex')
  }

  private targetContext(
    binding: BrowserContinuationBinding,
    page: BrowserPageReadResult,
    visibleNodes: readonly BrowserInspectionNode[],
    target: BrowserInspectionNode,
  ): BrowserActionTargetContext {
    const byAxId = new Map(visibleNodes.map((node) => [node.axNodeId, node]))
    const ancestors: BrowserInspectionNode[] = []
    let current = target.parentAxNodeId ? byAxId.get(target.parentAxNodeId) : undefined
    const seen = new Set<string>()
    while (current && !seen.has(current.axNodeId)) {
      ancestors.push(current)
      seen.add(current.axNodeId)
      current = current.parentAxNodeId ? byAxId.get(current.parentAxNodeId) : undefined
    }
    const formOwned = ancestors.some((node) => (
      normalizedRole(node.role) === 'form' || node.dom.tagName.toLowerCase() === 'form'
    ))
    const siblings = visibleNodes.filter((node) => (
      node.backendNodeId !== target.backendNodeId && node.parentAxNodeId === target.parentAxNodeId
    ))
    const nearbyLabels = [...siblings, ...ancestors]
      .map((node) => safeText(node.name))
      .filter((value): value is string => value !== undefined)
      .slice(0, 16)
    const inputType = target.dom.inputType?.toLowerCase()
    const role = normalizedRole(target.role)
    const expectedNavigation = inputType === 'submit'
      || inputType === 'image'
      || (formOwned && (role === 'button' || role === 'link'))
    const manualLocators = new Set((binding.browserContinuation?.manualActions ?? []).map(({ locator }) => locator))
    const manualAction = page.locatorMatches.some(({ locator, backendNodeIds }) => (
      manualLocators.has(locator) && backendNodeIds.includes(target.backendNodeId)
    ))
    return Object.freeze({
      formOwned,
      nearbyLabels: Object.freeze(nearbyLabels),
      ...(inputType === undefined ? {} : { inputType }),
      expectedNavigation,
      manualAction,
    })
  }

  private restrictedRegionBackendIds(
    mainFrameNodes: readonly BrowserInspectionNode[],
    visibleNodes: readonly BrowserInspectionNode[],
  ): ReadonlySet<number> {
    const byAxId = new Map(mainFrameNodes.map((node) => [node.axNodeId, node]))
    const childrenByAxId = new Map<string, BrowserInspectionNode[]>()
    for (const node of mainFrameNodes) {
      if (!node.parentAxNodeId) continue
      const children = childrenByAxId.get(node.parentAxNodeId)
      if (children) children.push(node)
      else childrenByAxId.set(node.parentAxNodeId, [node])
    }
    const restricted = new Set<number>()
    for (const node of visibleNodes.filter(imageRestrictedNode)) {
      let current: BrowserInspectionNode | undefined = node
      const seen = new Set<string>()
      while (current && !seen.has(current.axNodeId)) {
        restricted.add(current.backendNodeId)
        seen.add(current.axNodeId)
        current = current.parentAxNodeId ? byAxId.get(current.parentAxNodeId) : undefined
      }
      const descendants = [node]
      const descendantIds = new Set<string>()
      while (descendants.length > 0) {
        const descendant = descendants.pop()!
        if (descendantIds.has(descendant.axNodeId)) continue
        descendantIds.add(descendant.axNodeId)
        restricted.add(descendant.backendNodeId)
        descendants.push(...(childrenByAxId.get(descendant.axNodeId) ?? []))
      }
    }
    return restricted
  }

  private sameIdentity(
    state: SnapshotIdentity,
    input: SnapshotIdentity,
  ): boolean {
    return state.runId === input.runId
      && state.bindingId === input.bindingId
      && state.tabId === input.tabId
      && state.snapshotId === input.snapshotId
      && state.navigationEpoch === input.navigationEpoch
      && state.origin === input.origin
  }

  private invalidateTab(tabId: string): void {
    for (const [ref, state] of this.refs) if (state.tabId === tabId) this.refs.delete(ref)
    for (const [cursor, state] of this.cursors) if (state.tabId === tabId) this.cursors.delete(cursor)
  }

  private opaque(kind: 'snapshot' | 'cursor' | 'ref'): string {
    return `${kind}_${this.id()}`
  }
}
