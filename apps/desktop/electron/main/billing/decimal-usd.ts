interface FixedDecimal {
  digits: bigint
  scale: number
}

function parseFixed(value: string | number): FixedDecimal {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError('USD cost must be a non-negative finite decimal')
  }

  const source = typeof value === 'number' ? String(value) : value
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source)
  if (!match) throw new TypeError('USD cost must be a non-negative finite decimal')

  const fraction = match[2] ?? ''
  const exponent = Number(match[3] ?? '0')
  if (!Number.isSafeInteger(exponent)) throw new TypeError('USD exponent is out of range')

  const scale = fraction.length - exponent
  const rawDigits = BigInt(`${match[1]}${fraction}`)
  return scale < 0
    ? { digits: rawDigits * 10n ** BigInt(-scale), scale: 0 }
    : { digits: rawDigits, scale }
}

function formatFixed(digits: bigint, scale: number): string {
  const raw = digits.toString()
  if (scale === 0) return raw

  const padded = raw.padStart(scale + 1, '0')
  const integer = padded.slice(0, -scale) || '0'
  const fraction = padded.slice(-scale).replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

export function normalizeUsd(value: string | number): string {
  const parsed = parseFixed(value)
  return formatFixed(parsed.digits, parsed.scale)
}

export function addUsd(values: Iterable<string>): string {
  const parsed = Array.from(values, parseFixed)
  const maxScale = parsed.reduce((max, value) => Math.max(max, value.scale), 0)
  const digits = parsed.reduce(
    (total, value) => total + value.digits * 10n ** BigInt(maxScale - value.scale),
    0n,
  )
  return formatFixed(digits, maxScale)
}
