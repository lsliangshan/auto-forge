import { z } from 'zod'

const domainPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

function canonicalProxyUrl(
  value: string,
  protocols: ReadonlySet<string>,
): string | undefined {
  try {
    const trimmed = value.trim()
    const parsed = new URL(trimmed)
    if (!protocols.has(parsed.protocol)
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port === ''
      || (parsed.pathname !== '' && parsed.pathname !== '/')
      || parsed.search !== ''
      || parsed.hash !== '') return undefined
    return `${parsed.protocol}//${parsed.host}`
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

export const proxySettingsSchema = z.object({
  enabled: z.boolean(),
  httpProxy: httpProxySchema.optional(),
  httpsProxy: httpProxySchema.optional(),
  socketProxy: socketProxySchema.optional(),
  bypassDomains: z.array(z.string()).max(256),
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

function parseProxyBypassEntry(value: string): string | undefined {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined

  const cidrParts = normalized.split('/')
  if (cidrParts.length === 2) {
    const [address, prefix] = cidrParts
    const canonicalAddress = canonicalIpLiteral(address)
    if (!canonicalAddress || !/^\d+$/u.test(prefix)) return undefined
    const prefixLength = Number(prefix)
    const maximumPrefixLength = canonicalAddress.includes(':') ? 128 : 32
    return prefixLength <= maximumPrefixLength ? `${canonicalAddress}/${prefixLength}` : undefined
  }
  if (cidrParts.length !== 1) return undefined

  const canonicalIp = canonicalIpLiteral(normalized)
  if (canonicalIp && (/^[0-9.]+$/u.test(normalized) || normalized.includes(':'))) return canonicalIp
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
  return proxySettingsSchema.parse({
    enabled: value.enabled,
    httpProxy: normalizeProxyAddress(value.httpProxy, new Set(['http:', 'https:'])),
    httpsProxy: normalizeProxyAddress(value.httpsProxy, new Set(['http:', 'https:'])),
    socketProxy: normalizeProxyAddress(value.socketProxy, new Set(['socks4:', 'socks5:'])),
    bypassDomains: parseProxyBypassText(value.bypassDomains.join('\n')),
  })
}
