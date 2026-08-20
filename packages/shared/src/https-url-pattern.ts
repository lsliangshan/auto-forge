interface ParsedHttpsUrlPattern {
  host: string
  hostHasWildcard: boolean
  port: string
  path?: string
}

const schemePattern = /^([A-Za-z][A-Za-z\d+.-]*):\/\//
const hostnameLabelPattern = /^[A-Za-z\d*](?:[A-Za-z\d*-]*[A-Za-z\d*])?$/

function normalizedGlob(value: string): string {
  return value.replace(/\*+/g, '*')
}

function parseWildcardPattern(value: string, schemeLength: number): ParsedHttpsUrlPattern | undefined {
  const remainder = value.slice(schemeLength)
  const slashIndex = remainder.indexOf('/')
  const authority = slashIndex < 0 ? remainder : remainder.slice(0, slashIndex)
  const path = slashIndex < 0 ? undefined : remainder.slice(slashIndex)
  if (!authority || authority.includes('@') || authority.includes('[') || authority.includes(']')) return undefined

  const colonIndex = authority.lastIndexOf(':')
  if (colonIndex !== authority.indexOf(':')) return undefined
  const host = (colonIndex < 0 ? authority : authority.slice(0, colonIndex)).toLowerCase()
  const portText = colonIndex < 0 ? '' : authority.slice(colonIndex + 1)
  if (colonIndex >= 0 && !portText) return undefined
  if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return undefined
  if (!host.split('.').every((label) => hostnameLabelPattern.test(label))) return undefined
  if (!/[A-Za-z\d]/.test(host) || /^[\d.*]+$/.test(host)) return undefined
  if (portText && !/^\d+$/.test(portText)) return undefined
  const port = portText ? Number(portText) : 443
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  if (path?.includes('\\')) return undefined

  return {
    host: normalizedGlob(host),
    hostHasWildcard: true,
    port: port === 443 ? '' : String(port),
    ...(path && path !== '/*' ? { path: normalizedGlob(path) } : {}),
  }
}

function parseExactPattern(value: string, schemeLength: number): ParsedHttpsUrlPattern | undefined {
  const remainder = value.slice(schemeLength)
  const slashIndex = remainder.indexOf('/')
  const authority = slashIndex < 0 ? remainder : remainder.slice(0, slashIndex)
  const hasPath = slashIndex >= 0
  if (!authority || authority.endsWith(':')) return undefined
  try {
    const url = new URL(schemeLength ? value : `https://${value}`)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hostname.includes('..')) return undefined
    return {
      host: url.hostname.toLowerCase(),
      hostHasWildcard: false,
      port: url.port,
      ...(hasPath ? { path: url.pathname } : {}),
    }
  } catch {
    return undefined
  }
}

function parseHttpsUrlPattern(value: string): ParsedHttpsUrlPattern | undefined {
  if (!value || value !== value.trim() || value.includes('?') || value.includes('#') || value.includes('\\')) return undefined
  const scheme = value.match(schemePattern)
  if (scheme && scheme[1]?.toLowerCase() !== 'https') return undefined
  const schemeLength = scheme?.[0].length ?? 0
  if (!scheme && value.includes('://')) return undefined
  return value.includes('*')
    ? parseWildcardPattern(value, schemeLength)
    : parseExactPattern(value, schemeLength)
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function globMatches(pattern: string, value: string, caseInsensitive = false): boolean {
  const expression = normalizedGlob(pattern)
    .split('*')
    .map(escapeRegularExpression)
    .join('.*')
  return new RegExp(`^${expression}$`, caseInsensitive ? 'i' : undefined).test(value)
}

function isIpHostname(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function parseTarget(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url : undefined
  } catch {
    return undefined
  }
}

function matchesHostAndPort(pattern: ParsedHttpsUrlPattern, target: URL): boolean {
  if (pattern.hostHasWildcard && isIpHostname(target.hostname)) return false
  return pattern.port === target.port
    && globMatches(pattern.host, target.hostname.toLowerCase(), true)
}

export function isHttpsUrlPattern(value: string): boolean {
  return parseHttpsUrlPattern(value) !== undefined
}

export function matchesHttpsUrlPattern(pattern: string, targetUrl: string): boolean {
  const parsedPattern = parseHttpsUrlPattern(pattern)
  const target = parseTarget(targetUrl)
  if (!parsedPattern || !target || !matchesHostAndPort(parsedPattern, target)) return false
  return parsedPattern.path === undefined || globMatches(parsedPattern.path, target.pathname)
}

export function matchesHttpsUrlPatternOrigin(pattern: string, targetOrigin: string): boolean {
  const parsedPattern = parseHttpsUrlPattern(pattern)
  const target = parseTarget(targetOrigin)
  return Boolean(parsedPattern && target && matchesHostAndPort(parsedPattern, target))
}
