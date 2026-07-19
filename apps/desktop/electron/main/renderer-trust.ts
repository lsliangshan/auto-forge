import { pathToFileURL } from 'node:url'

export type RendererTarget =
  | { kind: 'development'; origin: string }
  | { kind: 'production'; filePath: string }

function exactFileLocation(actual: URL, expected: URL): boolean {
  return actual.protocol === expected.protocol
    && actual.hostname === expected.hostname
    && actual.host === expected.host
    && actual.pathname === expected.pathname
    && actual.port === expected.port
    && actual.username === expected.username
    && actual.password === expected.password
    && actual.search === expected.search
}

export function isTrustedRendererUrl(value: string, target: RendererTarget): boolean {
  try {
    if (target.kind === 'development') return new URL(value).origin === target.origin
    const location = value.slice(0, value.indexOf('#') === -1 ? value.length : value.indexOf('#'))
    if (/\\|%5c|%2f/i.test(location)) return false
    const actual = new URL(value)
    const expected = pathToFileURL(target.filePath)
    if (!exactFileLocation(actual, expected)) return false
    actual.hash = ''
    return actual.href === expected.href
  } catch {
    return false
  }
}
