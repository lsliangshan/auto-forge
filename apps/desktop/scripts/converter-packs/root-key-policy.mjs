import { createHash } from 'node:crypto'

const disallowedProductionFingerprints = new Set([
  // RFC 8032 test vector 1, used by AutoForge's local/test converter fixtures.
  '06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9',
])

export function isDisallowedProductionConverterRootKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const fingerprint = createHash('sha256').update(der).digest('hex')
  return disallowedProductionFingerprints.has(fingerprint)
}
