import { z } from 'zod'

const domainPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

function explicitProxyPort(value: string): string | undefined {
  const schemeEnd = value.indexOf('://')
  if (schemeEnd < 0) return undefined
  const authorityStart = schemeEnd + 3
  const authorityRemainder = value.slice(authorityStart)
  const authorityEnd = authorityRemainder.search(/[/?#]/u)
  const authority = authorityEnd < 0
    ? authorityRemainder
    : authorityRemainder.slice(0, authorityEnd)
  const hostnameAndPort = authority.slice(authority.lastIndexOf('@') + 1)
  const portSeparator = hostnameAndPort.startsWith('[')
    ? hostnameAndPort.indexOf(']') + 1
    : hostnameAndPort.lastIndexOf(':')
  if (portSeparator <= 0 || hostnameAndPort[portSeparator] !== ':') return undefined
  const rawPort = hostnameAndPort.slice(portSeparator + 1)
  if (!/^\d+$/u.test(rawPort)) return undefined
  const port = Number(rawPort)
  return Number.isSafeInteger(port) && port <= 65_535 ? String(port) : undefined
}

function canonicalProxyUrl(
  value: string,
  protocols: ReadonlySet<string>,
): string | undefined {
  try {
    const trimmed = value.trim()
    const parsed = new URL(trimmed)
    const port = explicitProxyPort(trimmed)
    if (!protocols.has(parsed.protocol)
      || parsed.username !== ''
      || parsed.password !== ''
      || port === undefined
      || (parsed.pathname !== '' && parsed.pathname !== '/')
      || parsed.search !== ''
      || parsed.hash !== '') return undefined
    return `${parsed.protocol}//${parsed.hostname}:${port}`
  } catch {
    return undefined
  }
}

const httpProxySchema = z.string().superRefine((value, context) => {
  if (!canonicalProxyUrl(value, new Set(['http:', 'https:']))) {
    context.addIssue({ code: 'custom', message: 'Invalid HTTP proxy URL' })
  }
})

const socketProxySchema = z.string().superRefine((value, context) => {
  if (!canonicalProxyUrl(value, new Set(['socks4:', 'socks5:']))) {
    context.addIssue({ code: 'custom', message: 'Invalid SOCKS proxy URL' })
  }
})

const proxyBypassEntrySchema = z.string().superRefine((value, context) => {
  if (/[,\r\n]/u.test(value) || parseProxyBypassEntry(value) === undefined) {
    context.addIssue({ code: 'custom', message: 'Invalid proxy bypass entry' })
  }
})

export const proxySettingsSchema = z.object({
  enabled: z.boolean(),
  httpProxy: httpProxySchema.optional(),
  httpsProxy: httpProxySchema.optional(),
  socketProxy: socketProxySchema.optional(),
  bypassDomains: z.array(proxyBypassEntrySchema).max(256),
}).strict().superRefine((value, context) => {
  if (value.enabled && !value.httpProxy && !value.httpsProxy && !value.socketProxy) {
    context.addIssue({ code: 'custom', path: ['enabled'], message: 'At least one proxy is required' })
  }
})

export type ProxySettings = z.infer<typeof proxySettingsSchema>

function canonicalIpLiteral(value: string): string | undefined {
  const isIpv6 = value.includes(':')
  const authority = isIpv6 ? `[${value}]` : value

  try {
    const parsed = new URL(`http://${authority}`)
    const hostname = isIpv6 ? parsed.hostname.slice(1, -1) : parsed.hostname
    if (parsed.port !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== ''
      || hostname !== value) return undefined
    return hostname
  } catch {
    return undefined
  }
}

function isIpLiteral(value: string): boolean {
  return /^[0-9.]+$/u.test(value) || value.includes(':')
}

function parseProxyBypassEntry(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined

  const cidrParts = normalized.split('/')
  if (cidrParts.length === 2) {
    const [address, prefix] = cidrParts
    const canonicalAddress = canonicalIpLiteral(address)
    if (!canonicalAddress || !isIpLiteral(address) || !/^\d+$/u.test(prefix)) return undefined
    const prefixLength = Number(prefix)
    const maximumPrefixLength = canonicalAddress.includes(':') ? 128 : 32
    return prefixLength <= maximumPrefixLength ? `${canonicalAddress}/${prefixLength}` : undefined
  }
  if (cidrParts.length !== 1) return undefined

  const canonicalIp = canonicalIpLiteral(normalized)
  if (canonicalIp && isIpLiteral(normalized)) return canonicalIp
  return domainPattern.test(normalized) ? normalized : undefined
}

export function parseProxyBypassText(value: string): string[] {
  const entries = value.split(/[,\n]/u)
  const parsed = entries.map(parseProxyBypassEntry).filter((entry): entry is string => entry !== undefined)
  return [...new Set(parsed)]
}

function normalizeProxyAddress(value: string | undefined, protocols: ReadonlySet<string>): string | undefined {
  if (value === undefined || !value.trim()) return undefined
  return canonicalProxyUrl(value, protocols) ?? value.trim()
}

export function normalizeProxySettings(value: ProxySettings): ProxySettings {
  const parsed = proxySettingsSchema.parse(value)
  return proxySettingsSchema.parse({
    enabled: parsed.enabled,
    httpProxy: normalizeProxyAddress(parsed.httpProxy, new Set(['http:', 'https:'])),
    httpsProxy: normalizeProxyAddress(parsed.httpsProxy, new Set(['http:', 'https:'])),
    socketProxy: normalizeProxyAddress(parsed.socketProxy, new Set(['socks4:', 'socks5:'])),
    bypassDomains: [...new Set(parsed.bypassDomains.map((entry) => parseProxyBypassEntry(entry)!))],
  })
}
