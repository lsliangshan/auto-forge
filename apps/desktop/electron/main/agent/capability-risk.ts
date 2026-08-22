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
