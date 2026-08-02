import type { LookupAddress } from 'node:dns'
import { normalizeProxySettings } from '@autoforge/shared'
import { describe, expect, it } from 'vitest'
import { selectMediaRoute, validatedPublicAddresses } from './media-route.js'

const address = (value: string, family: 4 | 6): LookupAddress => ({
  address: value,
  family,
})

const candidates = validatedPublicAddresses([
  address('93.184.216.34', 4),
  address('1.1.1.1', 4),
])

const invalidAnswerSets: readonly (readonly LookupAddress[])[] = [
  [],
  [address('127.0.0.1', 4)],
  [address('93.184.216.34', 4), address('10.0.0.1', 4)],
  [address('2001:db8::1', 6)],
]

describe('validatedPublicAddresses', () => {
  it('deduplicates public answers in resolver order', () => {
    expect(validatedPublicAddresses([
      address('93.184.216.34', 4),
      address('2606:4700:4700::1111', 6),
      address('93.184.216.34', 4),
    ])).toEqual([
      address('93.184.216.34', 4),
      address('2606:4700:4700::1111', 6),
    ])
  })

  it.each(invalidAnswerSets.map((answers) => [answers] as const))(
    'rejects empty, restricted, and mixed DNS answers before routing',
    (answers) => {
    expect(() => validatedPublicAddresses(answers)).toThrow()
    },
  )
})

describe('selectMediaRoute', () => {
  const settings = normalizeProxySettings({
    enabled: true,
    httpProxy: 'http://proxy.test:8080',
    httpsProxy: 'https://proxy.test:8443',
    socketProxy: 'socks5://proxy.test:1080',
    bypassDomains: ['exact.example', '*.wild.example'],
  })

  it('uses direct routing when proxy settings are disabled', () => {
    expect(selectMediaRoute(
      normalizeProxySettings({ enabled: false, bypassDomains: [] }),
      'media.example',
      candidates,
    )).toEqual({ route: { kind: 'direct' }, destinationAddresses: candidates })
  })

  it('prioritizes HTTPS proxy routing when no bypass matches', () => {
    expect(selectMediaRoute(settings, 'media.example', candidates)).toEqual({
      route: { kind: 'http-connect', proxyUrl: 'https://proxy.test:8443' },
      destinationAddresses: candidates,
    })
  })

  it('routes exact and wildcard subdomains directly without matching the wildcard root', () => {
    expect(selectMediaRoute(settings, 'exact.example', candidates).route)
      .toEqual({ kind: 'direct' })
    expect(selectMediaRoute(settings, 'child.wild.example', candidates).route)
      .toEqual({ kind: 'direct' })
    expect(selectMediaRoute(settings, 'wild.example', candidates).route)
      .toEqual({ kind: 'http-connect', proxyUrl: 'https://proxy.test:8443' })
  })

  it('confines IP and CIDR bypasses to matching destination addresses', () => {
    const ipBypass = normalizeProxySettings({
      enabled: true,
      httpProxy: 'http://proxy.test:8080',
      bypassDomains: ['93.184.216.34', '1.1.1.0/24'],
    })

    expect(selectMediaRoute(ipBypass, 'media.example', candidates)).toEqual({
      route: { kind: 'direct' },
      destinationAddresses: [
        address('93.184.216.34', 4),
        address('1.1.1.1', 4),
      ],
    })
  })

  it('falls back to SOCKS and then HTTP CONNECT proxy routes', () => {
    const socketOnly = normalizeProxySettings({
      enabled: true,
      socketProxy: 'socks5://proxy.test:1080',
      bypassDomains: [],
    })
    const httpOnly = normalizeProxySettings({
      enabled: true,
      httpProxy: 'http://proxy.test:8080',
      bypassDomains: [],
    })

    expect(selectMediaRoute(socketOnly, 'media.example', candidates).route)
      .toEqual({ kind: 'socks', proxyUrl: 'socks5://proxy.test:1080' })
    expect(selectMediaRoute(httpOnly, 'media.example', candidates).route)
      .toEqual({ kind: 'http-connect', proxyUrl: 'http://proxy.test:8080' })
  })
})
