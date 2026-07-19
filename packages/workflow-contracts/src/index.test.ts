import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  hostMatches,
  parseWorkflowManifest,
  type ReleaseManifest
} from './index'
import { signReleaseManifest, verifyReleaseManifest } from './node'

const validManifest = {
  schemaVersion: 1,
  sdkVersion: 1,
  slug: 'invoice-exporter',
  name: '发票导出',
  description: '从后台批量导出发票。',
  version: '1.2.3',
  categorySlug: 'data-collection',
  entry: 'dist/index.mjs',
  targetHosts: ['*.example.com', 'localhost'],
  permissions: ['browser.navigate', 'browser.read']
}

describe('workflow manifest', () => {
  it('accepts the fixed contract and rejects invalid semver or permissions', () => {
    expect(parseWorkflowManifest(validManifest).slug).toBe('invoice-exporter')
    expect(() => parseWorkflowManifest({ ...validManifest, version: 'v1' })).toThrow()
    expect(() => parseWorkflowManifest({ ...validManifest, permissions: ['node.fs'] })).toThrow()
  })

  it('matches only the declared host boundary', () => {
    expect(hostMatches('app.example.com', ['*.example.com'])).toBe(true)
    expect(hostMatches('example.com', ['*.example.com'])).toBe(false)
    expect(hostMatches('example.com.evil.test', ['*.example.com'])).toBe(false)
  })
})

describe('signed releases', () => {
  it('canonicalizes object keys according to RFC 8785 ordering', () => {
    expect(canonicalize({ z: 1, a: { y: true, x: null } })).toBe('{"a":{"x":null,"y":true},"z":1}')
  })

  it('signs and verifies a release manifest and rejects tampering', () => {
    const keys = generateKeyPairSync('ed25519')
    const release: ReleaseManifest = {
      schemaVersion: 1,
      workflowId: 'wf_1',
      slug: 'invoice-exporter',
      version: '1.2.3',
      entry: 'dist/index.mjs',
      codeSha256: 'a'.repeat(64),
      packageSha256: 'b'.repeat(64),
      permissions: ['browser.read'],
      targetHosts: ['app.example.com'],
      publishedAt: '2026-07-19T00:00:00.000Z'
    }
    const signature = signReleaseManifest(release, keys.privateKey)
    expect(verifyReleaseManifest(release, signature, keys.publicKey)).toBe(true)
    expect(verifyReleaseManifest({ ...release, version: '1.2.4' }, signature, keys.publicKey)).toBe(false)
  })
})
