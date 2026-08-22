import type { BrowserAction } from '../browser/browser-continuation-types.js'

export type CapabilityRisk = 'safe_navigation' | 'sensitive_read' | 'external_action' | 'unsupported' | 'unknown'

const capabilityRisks: Readonly<Record<string, CapabilityRisk>> = {
  'browser.open': 'safe_navigation',
  'browser.url': 'safe_navigation',
  'browser.close': 'safe_navigation',
  'browser.fill': 'external_action',
  'browser.click': 'external_action',
  'clipboard.read': 'sensitive_read',
  'filesystem.write': 'external_action',
  'network.fetch': 'unsupported',
  'filesystem.read': 'unsupported',
  'clipboard.write': 'unsupported',
  'notification.send': 'unsupported',
  'artifact.create': 'unsupported',
}

export function classifyCapability(capability: string): CapabilityRisk {
  return capabilityRisks[capability] ?? 'unknown'
}

export function classifyBrowserActionRisk(
  action: BrowserAction,
): Extract<CapabilityRisk, 'safe_navigation' | 'external_action'> {
  switch (action.type) {
    case 'fill':
    case 'select':
    case 'click':
    case 'check':
      return 'external_action'
    case 'navigate':
    case 'scroll':
    case 'wait':
    case 'focus':
      return 'safe_navigation'
  }
}
