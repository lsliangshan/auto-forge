import {
  matchesHttpsUrlPattern,
  matchesHttpsUrlPatternOrigin,
  parseBrowserLocator,
  type AppErrorCode,
} from '@autoforge/shared'
import type { BrowserPermissionMatrix } from '../workflows/workflow-security-fingerprint.js'
import type {
  BrowserAction,
  BrowserActionTargetContext,
  BrowserContinuationPolicy,
  BrowserPageSnapshot,
  BrowserSemanticNode,
} from './browser-continuation-types.js'
export type { BrowserActionTargetContext } from './browser-continuation-types.js'

export interface BrowserActionGuardContext {
  readonly origin: string
  readonly url: string
  readonly action: BrowserAction
  readonly target?: BrowserSemanticNode
  readonly targetContext?: BrowserActionTargetContext
  readonly auth: BrowserPageSnapshot['auth']
  readonly snapshotFresh: boolean
  readonly permissionMatrix: BrowserPermissionMatrix
  readonly browserContinuation?: BrowserContinuationPolicy
}

export type BrowserActionDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'blocked'; readonly code: AppErrorCode }
  | { readonly kind: 'handoff'; readonly code: 'AUTH_REQUIRED' | 'MANUAL_ACTION_REQUIRED' | 'UNSUPPORTED_CONTROL' }

const loginText = /(?:^|\s)(?:log[ -]?in|sign[ -]?in)(?:\s|$)|登录|登陆/iu
const logoutText = /退出登录|注销登录|log[ -]?out|sign[ -]?out/iu
const protectedText = /(?:正式|最终)?提交|确认(?:变更|申请|订单|发布|支付|删除|撤回)|支付|付款|购买|签名|签字|发布|删除|移除|撤回|撤销申请|退出登录|注销|withdraw|delete|remove|publish|payment|purchase|signature|log[ -]?out|sign[ -]?out|confirm|submit/iu
const fileText = /上传|附件|文件|upload|attachment|file/iu
const captchaText = /验证码|captcha/iu
const signatureText = /签名|签字|signature/iu
const paymentText = /支付|付款|银行卡|信用卡|订单|payment|credit card|debit card|purchase/iu
const draftText = /保存(?:草稿)?|暂存|save(?: draft)?/iu
const searchText = /搜索|查询|筛选|search|filter/iu
const paginationText = /^(?:上一页|下一页|首页|末页|previous|next|first|last|\d{1,4})$/iu

export function requiredCapability(
  action: BrowserAction,
): keyof BrowserPermissionMatrix | undefined {
  switch (action.type) {
    case 'fill':
    case 'select':
      return 'browser.fill'
    case 'click':
    case 'check':
      return 'browser.click'
    case 'navigate':
      return 'browser.open'
    case 'scroll':
    case 'wait':
    case 'focus':
      return undefined
  }
}

function actionSupported(action: BrowserAction, target: BrowserSemanticNode | undefined): boolean {
  if (action.type === 'navigate' || action.type === 'wait' || action.type === 'focus') return true
  if (action.type === 'scroll' && action.ref === undefined) return true
  if (!target || ('ref' in action && action.ref !== target.ref)) return false
  return target.actions.includes(action.type as BrowserSemanticNode['actions'][number])
}

function exactManualAction(context: BrowserActionGuardContext): boolean {
  if (context.targetContext?.manualAction !== undefined) return context.targetContext.manualAction
  const configured = context.browserContinuation?.manualActions ?? []
  if (configured.length === 0 || !context.target) return false
  return configured.some(({ locator }) => {
    const parsed = parseBrowserLocator(locator)
    if (!parsed) return true
    if (parsed.kind === 'css') return true
    return parsed.value === context.target!.role
      && (parsed.name === undefined || parsed.name === context.target!.name)
  })
}

function targetEvidence(context: BrowserActionGuardContext): string {
  return [context.target?.name ?? '', ...(context.targetContext?.nearbyLabels ?? [])].join(' ')
}

function currentOriginAllowed(context: BrowserActionGuardContext): boolean {
  return Object.values(context.permissionMatrix).flat()
    .some((pattern) => matchesHttpsUrlPatternOrigin(pattern, context.origin))
}

function requiredScopeAllowed(context: BrowserActionGuardContext): boolean {
  const capability = requiredCapability(context.action)
  if (capability === undefined) return currentOriginAllowed(context)
  const targetUrl = context.action.type === 'navigate' ? context.action.url : context.url
  return (context.permissionMatrix[capability] ?? [])
    .some((pattern) => matchesHttpsUrlPattern(pattern, targetUrl))
}

function reversibleClick(context: BrowserActionGuardContext): boolean {
  const target = context.target!
  if (target.role === 'tab') return true
  const evidence = targetEvidence(context)
  if (draftText.test(evidence) || searchText.test(evidence) || paginationText.test(target.name.trim())) {
    return true
  }
  return false
}

export class BrowserActionGuard {
  decide(context: BrowserActionGuardContext): BrowserActionDecision {
    if (!context.snapshotFresh) return { kind: 'blocked', code: 'PAGE_CHANGED' }
    if (!currentOriginAllowed(context) || !requiredScopeAllowed(context)) {
      return { kind: 'blocked', code: 'DOMAIN_BLOCKED' }
    }
    if (context.auth === 'required'
      || (loginText.test(targetEvidence(context)) && !logoutText.test(targetEvidence(context)))
      || context.targetContext?.inputType?.toLowerCase() === 'password') {
      return { kind: 'handoff', code: 'AUTH_REQUIRED' }
    }
    if (exactManualAction(context)) return { kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' }

    const evidence = targetEvidence(context)
    const inputType = context.targetContext?.inputType?.toLowerCase()
    if (inputType === 'file' || fileText.test(evidence) || captchaText.test(evidence)) {
      return { kind: 'handoff', code: 'UNSUPPORTED_CONTROL' }
    }
    if (signatureText.test(evidence) || paymentText.test(evidence) || protectedText.test(evidence)) {
      return { kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' }
    }
    if (context.target?.enabled === false || !actionSupported(context.action, context.target)) {
      return { kind: 'blocked', code: context.target ? 'UNSUPPORTED_CONTROL' : 'PAGE_CHANGED' }
    }
    if (context.action.type === 'click') {
      if (context.targetContext?.formOwned && context.targetContext.expectedNavigation) {
        return { kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' }
      }
      return reversibleClick(context)
        ? { kind: 'allowed' }
        : { kind: 'handoff', code: 'MANUAL_ACTION_REQUIRED' }
    }
    return { kind: 'allowed' }
  }
}
