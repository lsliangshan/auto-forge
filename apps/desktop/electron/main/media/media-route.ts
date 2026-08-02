import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import type { ProxySettings } from '@autoforge/shared'

export type MediaRoute =
  | { kind: 'direct' }
  | { kind: 'http-connect'; proxyUrl: string }
  | { kind: 'socks'; proxyUrl: string }

export interface MediaRouteSelection {
  route: MediaRoute
  destinationAddresses: readonly LookupAddress[]
}

function parseIpv4(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined
  const octets = address.split('.').map(Number)
  return octets.length === 4 ? octets : undefined
}

function ipv6Bytes(address: string): Uint8Array | undefined {
  if (isIP(address) !== 6 || address.includes('%')) return undefined
  let normalized = address.toLowerCase()
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1]
  if (ipv4Tail) {
    const octets = parseIpv4(ipv4Tail)
    if (!octets) return undefined
    const replacement = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
    normalized = normalized.slice(0, -ipv4Tail.length) + replacement
  }

  const halves = normalized.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map((part) => Number.parseInt(part, 16))
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return undefined
  }

  const bytes = new Uint8Array(16)
  words.forEach((word, index) => {
    bytes[index * 2] = word >> 8
    bytes[index * 2 + 1] = word & 0xff
  })
  return bytes
}

function matchesPrefix(bytes: Uint8Array, prefix: ArrayLike<number>, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8)
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  const remaining = bits % 8
  if (remaining === 0) return true
  const mask = 0xff << (8 - remaining)
  return (bytes[fullBytes]! & mask) === (prefix[fullBytes]! & mask)
}

interface AddressPrefix {
  bytes: Uint8Array
  bits: number
}

function addressPrefix(cidr: string, family: 4 | 6): AddressPrefix {
  const separator = cidr.lastIndexOf('/')
  const address = cidr.slice(0, separator)
  const bits = Number(cidr.slice(separator + 1))
  const bytes = family === 4 ? parseIpv4(address) : ipv6Bytes(address)
  const maximumBits = family === 4 ? 32 : 128
  if (!bytes || !Number.isInteger(bits) || bits < 0 || bits > maximumBits) {
    throw new Error('Invalid embedded address prefix')
  }
  return { bytes: Uint8Array.from(bytes), bits }
}

// Policy snapshot: IANA IPv4 and IPv6 Special-Purpose Address Registries,
// 2026-07-26. Every registered block is denied, including entries that IANA
// marks globally reachable. The 2001::/23 umbrella covers its listed subranges.
// Sources:
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const IANA_IPV4_SPECIAL_PREFIXES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map((cidr) => addressPrefix(cidr, 4))

const IANA_IPV6_SPECIAL_PREFIXES = [
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '100:0:0:1::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '2620:4f:8000::/48',
  '3fff::/20',
  '5f00::/16',
  'fc00::/7',
  'fe80::/10',
].map((cidr) => addressPrefix(cidr, 6))

// Deprecated site-local and multicast space are non-public architecture ranges
// outside the special-purpose registry snapshot and remain explicitly denied.
const ADDITIONAL_NON_PUBLIC_IPV6_PREFIXES = [
  'fec0::/10',
  'ff00::/8',
].map((cidr) => addressPrefix(cidr, 6))

const IPV6_GLOBAL_UNICAST_PREFIX = addressPrefix('2000::/3', 6)

function matchesAnyPrefix(bytes: Uint8Array, prefixes: readonly AddressPrefix[]): boolean {
  return prefixes.some((prefix) => matchesPrefix(bytes, prefix.bytes, prefix.bits))
}

function prohibitedIpv4(address: string): boolean {
  const bytes = parseIpv4(address)
  return !bytes || matchesAnyPrefix(Uint8Array.from(bytes), IANA_IPV4_SPECIAL_PREFIXES)
}

function prohibitedIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address)
  return (
    !bytes
    || !matchesPrefix(bytes, IPV6_GLOBAL_UNICAST_PREFIX.bytes, IPV6_GLOBAL_UNICAST_PREFIX.bits)
    || matchesAnyPrefix(bytes, IANA_IPV6_SPECIAL_PREFIXES)
    || matchesAnyPrefix(bytes, ADDITIONAL_NON_PUBLIC_IPV6_PREFIXES)
  )
}

export function validatedPublicAddresses(
  addresses: readonly LookupAddress[],
): readonly LookupAddress[] {
  if (addresses.length === 0) throw new Error('Invalid media address set')
  const seen = new Set<string>()
  const validated: LookupAddress[] = []
  for (const answer of addresses) {
    if (
      typeof answer !== 'object'
      || answer === null
      || (answer.family !== 4 && answer.family !== 6)
      || isIP(answer.address) !== answer.family
      || (answer.family === 4
        ? prohibitedIpv4(answer.address)
        : prohibitedIpv6(answer.address))
    ) throw new Error('Invalid media address set')
    const key = `${answer.family}:${answer.address.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    validated.push({ address: answer.address, family: answer.family })
  }
  return Object.freeze(validated.map((answer) => Object.freeze({ ...answer })))
}

function addressMatchesRule(candidate: LookupAddress, rule: string): boolean {
  const separator = rule.lastIndexOf('/')
  const ruleAddress = separator === -1 ? rule : rule.slice(0, separator)
  const family = isIP(ruleAddress)
  if (family === 0 || family !== candidate.family) return false

  const candidateBytes = family === 4
    ? parseIpv4(candidate.address)
    : ipv6Bytes(candidate.address)
  const ruleBytes = family === 4 ? parseIpv4(ruleAddress) : ipv6Bytes(ruleAddress)
  if (!candidateBytes || !ruleBytes) return false

  const maximumBits = family === 4 ? 32 : 128
  const bits = separator === -1 ? maximumBits : Number(rule.slice(separator + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > maximumBits) return false
  return matchesPrefix(
    Uint8Array.from(candidateBytes),
    Uint8Array.from(ruleBytes),
    bits,
  )
}

export function selectMediaRoute(
  settings: ProxySettings,
  hostname: string,
  addresses: readonly LookupAddress[],
): MediaRouteSelection {
  if (!settings.enabled) {
    return { route: { kind: 'direct' }, destinationAddresses: addresses }
  }

  const normalizedHost = hostname.toLowerCase()
  const domainBypass = settings.bypassDomains.some((rule) => {
    if (isIP(rule) !== 0 || rule.includes('/')) return false
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2)
      return normalizedHost !== suffix && normalizedHost.endsWith(`.${suffix}`)
    }
    return normalizedHost === rule
  })
  if (domainBypass) {
    return { route: { kind: 'direct' }, destinationAddresses: addresses }
  }

  const matchingAddresses = addresses.filter((candidate) => (
    settings.bypassDomains.some((rule) => addressMatchesRule(candidate, rule))
  ))
  if (matchingAddresses.length > 0) {
    return { route: { kind: 'direct' }, destinationAddresses: matchingAddresses }
  }

  if (settings.httpsProxy) {
    return {
      route: { kind: 'http-connect', proxyUrl: settings.httpsProxy },
      destinationAddresses: addresses,
    }
  }
  if (settings.socketProxy) {
    return {
      route: { kind: 'socks', proxyUrl: settings.socketProxy },
      destinationAddresses: addresses,
    }
  }
  if (settings.httpProxy) {
    return {
      route: { kind: 'http-connect', proxyUrl: settings.httpProxy },
      destinationAddresses: addresses,
    }
  }
  throw new Error('Enabled proxy has no media route')
}
