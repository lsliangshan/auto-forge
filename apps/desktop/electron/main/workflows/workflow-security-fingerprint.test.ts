import { describe, expect, it } from 'vitest'
import type { WorkflowDetail } from '@autoforge/shared'
import { browserPermissionMatrix, workflowSecurityFingerprint } from './workflow-security-fingerprint.js'

function workflow(): WorkflowDetail {
  return {
    id: 'workflow.browser',
    version: '1.0.0',
    name: 'Browser workflow',
    description: 'Continues a browser session',
    author: 'AutoForge',
    category: 'automation',
    enabled: true,
    source: 'installed',
    integrity: 'valid',
    updatedAt: '2026-08-23T00:00:00.000Z',
    codeSha256: 'a'.repeat(64),
    cities: [],
    runtimeIdentity: { id: 'workflow.browser', version: '1.0.0', source: 'installed' },
    permissions: [
      { capability: 'browser.open', scope: { origins: ['https://open.example.gov.cn'] } },
      { capability: 'browser.click', scope: { origins: ['https://click.example.gov.cn'] } },
      { capability: 'browser.open', scope: { origins: ['https://open.example.gov.cn', 'https://second.example.gov.cn'] } },
    ],
    browserContinuation: {
      auth: { loginUrls: ['https://sso.example.gov.cn/login/*'], loggedIn: ['role=button[name="退出"]'] },
      readableRegions: ['role=main'],
      manualActions: [{ locator: 'role=button[name="正式提交"]', reason: '正式提交必须由用户完成' }],
    },
    activationExamples: ['继续办理'],
    activationNegativeExamples: [],
    timeoutMs: 30_000,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  }
}

describe('workflowSecurityFingerprint', () => {
  it('returns a SHA-256 hex digest that changes with continuation login and manual-action policy', () => {
    const baseline = workflowSecurityFingerprint(workflow())
    const changedLoginMarker = workflow()
    changedLoginMarker.browserContinuation!.auth!.loggedIn = ['role=button[name="账户"]']
    const changedManualAction = workflow()
    changedManualAction.browserContinuation!.manualActions![0]!.reason = '用户必须亲自正式提交'

    expect(baseline).toMatch(/^[a-f0-9]{64}$/)
    expect(workflowSecurityFingerprint(changedLoginMarker)).not.toBe(baseline)
    expect(workflowSecurityFingerprint(changedManualAction)).not.toBe(baseline)
  })

  it('keeps each browser capability scoped to its declared origins', () => {
    expect(browserPermissionMatrix(workflow())).toEqual({
      'browser.open': ['https://open.example.gov.cn', 'https://second.example.gov.cn'],
      'browser.click': ['https://click.example.gov.cn'],
    })
  })
})
