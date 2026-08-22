import { describe, expect, it } from 'vitest'
import { classifyCapability } from './capability-risk.js'

describe('classifyCapability', () => {
  it.each([
    ['browser.open', 'safe_navigation'], ['browser.url', 'safe_navigation'],
    ['browser.close', 'safe_navigation'], ['browser.fill', 'external_action'],
    ['browser.click', 'external_action'], ['clipboard.read', 'sensitive_read'],
    ['filesystem.write', 'external_action'], ['network.fetch', 'unsupported'],
    ['filesystem.read', 'unsupported'], ['clipboard.write', 'unsupported'],
    ['notification.send', 'unsupported'], ['artifact.create', 'unsupported'],
    ['future.unknown', 'unknown'],
  ] as const)('classifies %s as %s', (capability, expected) => {
    expect(classifyCapability(capability)).toBe(expected)
  })
})
