const redacted = '[REDACTED]'

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized === 'authorization'
    || normalized === 'cookie'
    || normalized === 'setcookie'
    || normalized.includes('token')
    || normalized.includes('apikey')
}

export function redact(value: unknown, sensitivePaths: readonly string[] = []): unknown {
  const paths = new Set(sensitivePaths)

  function visit(current: unknown, path: string): unknown {
    if (paths.has(path)) return redacted
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}.${index}`))
    if (typeof current !== 'object' || current === null) return current

    return Object.fromEntries(Object.entries(current).map(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key
      return [key, sensitiveKey(key) || paths.has(childPath) ? redacted : visit(child, childPath)]
    }))
  }

  return visit(value, '')
}
