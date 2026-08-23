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
  readonly href?: string
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
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}

interface BrowserNodeReadInput {
  readonly tabId: string
  readonly runId: string
  readonly expectedOrigin: string
  readonly expectedNavigationEpoch: number
  readonly backendNodeId: number
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
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
  readonly signal?: AbortSignal
}

export interface BrowserRefResolutionInput {
  readonly lease: BrowserContinuationLease
  readonly tabId: string
  readonly snapshotId: string
  readonly navigationEpoch: number
  readonly origin: string
  readonly ref: string
  readonly signal?: AbortSignal
}

export interface BrowserPageContextInput {
  readonly lease: BrowserContinuationLease
  readonly tabId: string
  readonly navigationEpoch: number
  readonly origin: string
  readonly signal?: AbortSignal
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
  readonly inspectionTimeoutMs?: number
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
  readonly href?: string
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
const maxStaticFieldLabelLength = 80
const maxStaticFieldValueLength = 256
export const MAX_BROWSER_INSPECTION_RAW_NODES = 1_500
export const MAX_BROWSER_INSPECTION_RAW_BYTES = 4 * 1024 * 1024
export const MAX_BROWSER_INSPECTION_LOCATOR_MATCHES = 256
const maxBrowserInspectionTotalLocatorMatches = 2_048
const maxBrowserInspectionPolicyLocators = 128
const defaultInspectionTimeoutMs = 5_000

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
const sensitiveStaticFieldLabel = /(?:authorization|bearer|cookie|credential|password|passcode|pin|secret|session|token|api[-_ ]?key|access[-_ ]?key|refresh[-_ ]?key|密码|口令|密钥|秘钥|令牌|验证码|校验码|动态码|身份证|身份号码|证件号码|社会保障号|银行卡|信用卡|借记卡|姓名|住址|地址|手机号|联系电话|邮箱|电子邮件)/iu
const instructionLikeText = /(?:(?:忽略|无视|覆盖|绕过).{0,16}(?:系统|策略|指令|提示)|(?:调用|使用|新增|添加|执行|提交|发送|上传|删除).{0,16}(?:工具|字段|数据|内容|请求)|(?:ignore|disregard|override|bypass).{0,24}(?:system|policy|prompt|instruction)|(?:call|invoke|add|submit|send|upload|delete).{0,24}(?:tool|field|data|content|request))/iu
const isoStaticDate = /^(\d{4})-(\d{2})-(\d{2})$/u
const chineseStaticDate = /^([0-9]{4})年([0-9]{2})月([0-9]{2})日$/u
const isoStaticDateToken = /\d{4}-\d{2}-\d{2}/u
const isoStaticDateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/u
const isoStaticDateRange = /^(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～|–)\s*(\d{4}-\d{2}-\d{2})$/u
const unsafeStaticFieldRawText = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const rawStaticTextRoles: ReadonlySet<string> = new Set(['StaticText', 'statictext', 'static-text'])
const staticDateLabels: ReadonlySet<string> = new Set([
  '有效期',
  '有效期至',
  '证件有效期',
  '工作居住证有效期',
  '到期日',
  '到期日期',
  '截止日期',
  '签发日期',
  '生效日期',
  '申请日期',
  'expiry date',
  'expiration date',
  'date of expiry',
  'valid until',
  'valid through',
  'expires on',
  'issue date',
  'date of issue',
  'effective date',
  'application date',
  'deadline date',
  'validity period',
])
const requestScopedCertificateNumberLabels: ReadonlySet<string> = new Set([
  '证件编号',
  '证书编号',
  '居住证编号',
  '工作居住证编号',
])
const requestScopedCertificateNumber = /^[A-Z0-9][A-Z0-9./_-]{5,30}[A-Z0-9]$/iu
const explicitCertificateNumberRequest = /(?:证件|证书|居住证|工作居住证)(?:的)?(?:编号|号码)/u
const requestScopedEducationLabels: ReadonlySet<string> = new Set([
  '学历',
  '最高学历',
  '文化程度',
  '学位',
  '最高学位',
])
const requestScopedEducationValues: ReadonlySet<string> = new Set([
  '小学',
  '初中',
  '普通高中',
  '高中',
  '中专',
  '职高',
  '技校',
  '大学专科',
  '大专',
  '专科',
  '大学本科',
  '本科',
  '研究生',
  '硕士研究生',
  '博士研究生',
  '学士',
  '硕士',
  '博士',
])
const explicitEducationRequest = /(?:学历|学位|文化程度)/u

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function normalizedRole(value: string): string {
  const role = value.replaceAll(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  if (role === 'static-text') return 'statictext'
  return role
}

function normalizedText(value: string): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('').replaceAll(/\s+/g, ' ').trim()
}

function containsStaticDateEvidence(value: string): boolean {
  const normalized = normalizedText(value).toLowerCase()
  return isoStaticDateToken.test(normalized)
    || [...staticDateLabels].some((label) => normalized.includes(label))
}

function validIsoStaticDate(value: string): boolean {
  const match = isoStaticDate.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= days[month - 1]!
}

function safeStaticDateValue(value: string): boolean {
  if (validIsoStaticDate(value)) return true
  const chineseDate = chineseStaticDate.exec(value)
  if (chineseDate && validIsoStaticDate(`${chineseDate[1]}-${chineseDate[2]}-${chineseDate[3]}`)) return true
  const range = isoStaticDateRange.exec(value)
  if (range) return validIsoStaticDate(range[1]!) && validIsoStaticDate(range[2]!)
  const dateTime = isoStaticDateTime.exec(value)
  if (!dateTime || !validIsoStaticDate(dateTime[1]!)) return false
  const hour = Number(dateTime[2])
  const minute = Number(dateTime[3])
  const second = Number(dateTime[4] ?? '0')
  const offsetHour = Number(dateTime[5] ?? '0')
  const offsetMinute = Number(dateTime[6] ?? '0')
  return hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 14
    && offsetMinute <= 59
    && (offsetHour !== 14 || offsetMinute === 0)
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

interface StructuredStaticField {
  readonly name: string
  readonly value: string
}

function structuredStaticField(
  rawText: string,
  intent: string,
): StructuredStaticField | null | undefined {
  if (unsafeStaticFieldRawText.test(rawText)) return null
  const delimiter = /[:：]/u.exec(rawText)
  if (!delimiter) return containsStaticDateEvidence(rawText) ? null : undefined
  if (rawText.slice(delimiter.index + delimiter[0].length).includes('：')) return null
  const label = normalizedText(rawText.slice(0, delimiter.index))
  const value = normalizedText(rawText.slice(delimiter.index + delimiter[0].length))
  if (!label || !value
    || [...label].length > maxStaticFieldLabelLength
    || [...value].length > maxStaticFieldValueLength) return null
  const safeLabel = safeText(label)
  if (!safeLabel) return null
  if (requestScopedCertificateNumberLabels.has(safeLabel.toLowerCase())
    && explicitCertificateNumberRequest.test(normalizedText(intent))
    && requestScopedCertificateNumber.test(value)
    && !chineseIdentity.test(value)
    && !instructionLikeText.test(value)) {
    return Object.freeze({ name: safeLabel, value })
  }
  if (requestScopedEducationLabels.has(safeLabel.toLowerCase())
    && explicitEducationRequest.test(normalizedText(intent))
    && requestScopedEducationValues.has(value.toLowerCase())) {
    return Object.freeze({ name: safeLabel, value })
  }
  const safeOriginal = safeText(rawText)
  const safeValue = safeText(value)
  if (!safeOriginal || instructionLikeText.test(safeOriginal)
    || !safeValue
    || sensitiveStaticFieldLabel.test(safeLabel)
    || sensitiveText(`${safeLabel}: ${safeValue}`)
    || instructionLikeText.test(safeValue)) return null
  if (!staticDateLabels.has(safeLabel.toLowerCase())) return null
  if (!relevantValue(safeLabel, intent)) return null
  if (!safeStaticDateValue(safeValue)) return null
  return Object.freeze({ name: safeLabel, value: safeValue })
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

function safeHref(value: string | undefined, pageUrl: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, pageUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
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
  private readonly inspectionTimeoutMs: number
  private readonly refs = new Map<string, RefState>()
  private readonly cursors = new Map<string, CursorState>()
  private readonly unsubscribeInvalidation: () => void

  constructor(private readonly port: BrowserPageCdpPort, options: InspectorOptions = {}) {
    this.id = options.id ?? randomUUID
    this.now = options.now ?? Date.now
    this.inspectionTimeoutMs = Math.max(1, options.inspectionTimeoutMs ?? defaultInspectionTimeoutMs)
    this.unsubscribeInvalidation = port.onPageInvalidated((tabId) => { this.invalidateTab(tabId) })
  }

  inspect(input: BrowserPageInspectInput & { readonly mode: 'region_image' }): Promise<BrowserRegionImage>
  inspect(input: BrowserPageInspectInput & { readonly mode?: 'semantic' }): Promise<BrowserPageSnapshot>
  async inspect(input: BrowserPageInspectInput): Promise<BrowserPageSnapshot | BrowserRegionImage> {
    this.assertBinding(input)
    if (input.signal?.aborted) throw failure('CANCELLED')
    const deadlineAt = Date.now() + this.inspectionTimeoutMs
    if (input.mode === 'region_image') {
      return this.withInspectionBudget(this.captureRegion(input, deadlineAt), input.signal, deadlineAt)
    }
    if (input.ref !== undefined) throw failure('INVALID_INPUT')
    if (input.cursor) return this.withInspectionBudget(this.nextPage(input, deadlineAt), input.signal, deadlineAt)
    return this.withInspectionBudget(this.captureSemantic(input, deadlineAt), input.signal, deadlineAt)
  }

  async resolveRef(input: BrowserRefResolutionInput): Promise<BrowserResolvedElementReference> {
    if (input.signal?.aborted) throw failure('CANCELLED')
    const deadlineAt = Date.now() + this.inspectionTimeoutMs
    return this.withInspectionBudget(this.resolveRefWithinBudget(input, deadlineAt), input.signal, deadlineAt)
  }

  private async resolveRefWithinBudget(
    input: BrowserRefResolutionInput,
    deadlineAt: number,
  ): Promise<BrowserResolvedElementReference> {
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
    const { page, visibleNodes, auth, semanticFingerprint } = await this.readLivePageContext(input, deadlineAt)
    const current = visibleNodes.find((node) => node.backendNodeId === state.backendNodeId)
    if (!current
      || current.ignored
      || current.dom.hidden
      || normalizedRole(current.role) !== state.role
      || safeText(current.name) !== state.name
      || current.dom.tagName.toLowerCase() !== state.tagName
      || current.dom.inputType?.toLowerCase() !== state.inputType
      || safeHref(current.dom.href, page.url) !== state.href
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
    if (input.signal?.aborted) throw failure('CANCELLED')
    const deadlineAt = Date.now() + this.inspectionTimeoutMs
    return this.withInspectionBudget((async () => {
      const { auth, semanticFingerprint } = await this.readLivePageContext(input, deadlineAt)
      return Object.freeze({ auth, semanticFingerprint })
    })(), input.signal, deadlineAt)
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

  private async captureSemantic(input: BrowserPageInspectInput, deadlineAt: number): Promise<BrowserPageSnapshot> {
    const binding = this.liveBinding(input.lease)
    const runId = input.lease.ownerRunId
    const locators = this.policyLocators(binding)
    const page = await this.port.readAccessibilitySnapshot({
      tabId: input.tabId,
      runId,
      expectedOrigin: input.origin,
      expectedNavigationEpoch: input.navigationEpoch,
      locators,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineAt,
    })
    this.liveBinding(input.lease)
    this.assertPage(input, page)
    this.assertRawBudget(page)
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
      const staticField = rawStaticTextRoles.has(node.role)
        ? structuredStaticField(node.name, input.intent)
        : undefined
      if (staticField === null) return []
      const name = staticField?.name ?? safeText(node.name)
      if (!name) return []
      const rawValue = node.value === undefined ? undefined : safeText(node.value)
      const value = staticField?.value ?? (
        valueRoles.has(role)
          && rawValue !== undefined
          && relevantValue(name, input.intent)
          && !imageRestrictedNode(node)
          ? rawValue
          : undefined
      )
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
        ...(role === 'link' && safeHref(node.dom.href, page.url) !== undefined
          ? { href: safeHref(node.dom.href, page.url)! }
          : {}),
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

  private async nextPage(input: BrowserPageInspectInput, deadlineAt: number): Promise<BrowserPageSnapshot> {
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineAt,
    })
    this.liveBinding(input.lease)
    this.assertPage(input, page)
    this.assertRawBudget(page)
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

  private async captureRegion(input: BrowserPageInspectInput, deadlineAt: number): Promise<BrowserRegionImage> {
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (state.imageRestricted) throw failure('UNSUPPORTED_CONTROL')
    const page = await this.port.readAccessibilitySnapshot({
      tabId: input.tabId,
      runId,
      expectedOrigin: input.origin,
      expectedNavigationEpoch: input.navigationEpoch,
      locators: this.policyLocators(binding),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineAt,
    })
    this.liveBinding(input.lease)
    this.assertPage(input, page)
    this.assertRawBudget(page)
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineAt,
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineAt,
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

  private withInspectionBudget<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(failure('CANCELLED'))
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) return Promise.reject(failure('ACTION_LIMIT_EXCEEDED'))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (result: { value: T } | { error: unknown }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if ('error' in result) reject(result.error)
        else resolve(result.value)
      }
      const onAbort = () => { finish({ error: failure('CANCELLED') }) }
      const timer = setTimeout(() => {
        finish({ error: failure('ACTION_LIMIT_EXCEEDED') })
      }, remaining)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      void operation.then(
        (value) => { finish({ value }) },
        (error) => { finish({ error }) },
      )
    })
  }

  private assertRawBudget(page: BrowserPageReadResult): void {
    const totalLocatorMatches = page.locatorMatches.reduce(
      (total, entry) => total + entry.backendNodeIds.length,
      0,
    )
    let serializedBytes = Number.POSITIVE_INFINITY
    const locatorFanOutExceeded = page.locatorMatches.some(({ backendNodeIds }) => (
        backendNodeIds.length > MAX_BROWSER_INSPECTION_LOCATOR_MATCHES
    ))
    if (page.nodes.length <= MAX_BROWSER_INSPECTION_RAW_NODES
      && !locatorFanOutExceeded
      && totalLocatorMatches <= maxBrowserInspectionTotalLocatorMatches) {
      try {
        serializedBytes = Buffer.byteLength(JSON.stringify({
          nodes: page.nodes,
          locatorMatches: page.locatorMatches,
        }), 'utf8')
      } catch { /* Non-serializable raw data fails the same closed budget boundary. */ }
    }
    if (page.nodes.length > MAX_BROWSER_INSPECTION_RAW_NODES
      || locatorFanOutExceeded
      || totalLocatorMatches > maxBrowserInspectionTotalLocatorMatches
      || serializedBytes > MAX_BROWSER_INSPECTION_RAW_BYTES) {
      throw failure('ACTION_LIMIT_EXCEEDED')
    }
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
    const locators = [
      ...(policy?.auth?.loggedIn ?? []),
      ...(policy?.auth?.loggedOut ?? []),
      ...(policy?.readableRegions ?? []),
      ...(policy?.manualActions ?? []).map(({ locator }) => locator),
    ]
    if (locators.length > maxBrowserInspectionPolicyLocators) throw failure('ACTION_LIMIT_EXCEEDED')
    return Object.freeze(locators)
  }

  private async readLivePageContext(input: BrowserPageContextInput, deadlineAt: number): Promise<{
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
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      deadlineAt,
    })
    this.liveBinding(input.lease)
    this.assertPage({ ...input, intent: 'live action validation' }, page)
    this.assertRawBudget(page)
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
    const href = safeHref(target.dom.href, page.url)
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
      ...(href === undefined ? {} : { href }),
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
