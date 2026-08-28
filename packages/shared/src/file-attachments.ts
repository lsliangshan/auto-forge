import type { ModelProviderId } from './desktop-api.js'

const providerFileMimeTypes = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const

export function chatFileSupport(
  provider: ModelProviderId,
  name: string,
  mimeType: string,
): { mode: 'text' } | { mode: 'provider-file'; mimeType: string } | { mode: 'unsupported' } {
  if (mimeType === 'text/plain') return { mode: 'text' }
  const suffixIndex = name.lastIndexOf('.')
  const suffix = suffixIndex === -1 ? undefined : name.slice(suffixIndex + 1).toLocaleLowerCase('en-US')
  const providerMimeType = suffix === undefined ? undefined : providerFileMimeTypes[suffix as keyof typeof providerFileMimeTypes]
  if (provider === 'openrouter' && providerMimeType !== undefined) {
    return { mode: 'provider-file', mimeType: providerMimeType }
  }
  return { mode: 'unsupported' }
}
