import { describe, expect, it } from 'vitest'
import { classifyBrowserActionRisk, classifyCapability } from './capability-risk.js'

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

describe('classifyBrowserActionRisk', () => {
  it.each([
    ['fill', 'external_action'], ['select', 'external_action'],
    ['click', 'external_action'], ['check', 'external_action'],
    ['navigate', 'safe_navigation'], ['scroll', 'safe_navigation'],
    ['wait', 'safe_navigation'], ['focus', 'safe_navigation'],
  ] as const)('classifies %s as %s without accepting a model-supplied risk', (type, expected) => {
    const action = type === 'fill' || type === 'select'
      ? { type, ref: 'ref_1', value: 'value', source: { kind: 'current_user' as const } }
      : type === 'click'
        ? { type, ref: 'ref_1' }
        : type === 'check'
          ? { type, ref: 'ref_1', checked: true, source: { kind: 'current_user' as const } }
          : type === 'navigate'
            ? { type, url: 'https://example.com' }
            : type === 'scroll'
              ? { type, direction: 'down' as const }
              : type === 'wait' ? { type, milliseconds: 50 } : { type }
    expect(classifyBrowserActionRisk(action)).toBe(expected)
  })
})
