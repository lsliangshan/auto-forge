export const CONVERTER_PACK_NAMES = ['image-icon', 'document', 'pdf', 'media'] as const
export type ConverterPackName = typeof CONVERTER_PACK_NAMES[number]

export type ConverterPackPlatform = 'darwin' | 'win32'
export type ConverterPackArchitecture = 'arm64' | 'x64'
export type ConverterPackEntryRole = 'executable' | 'code' | 'license' | 'data'

export interface ConverterPackEntry {
  path: string
  sha256: string
  bytes: number
  executable: boolean
  role: ConverterPackEntryRole
}

export interface ConverterPackDescriptor {
  name: ConverterPackName
  version: string
  platform: ConverterPackPlatform
  arch: ConverterPackArchitecture
  archiveUrl: string
  archiveSha256: string
  archiveBytes: number
  entries: ConverterPackEntry[]
}

export interface ConverterPackIndex {
  schemaVersion: 1
  generatedAt: string
  sequence: number
  packs: ConverterPackDescriptor[]
}

export interface SignedConverterPackIndex {
  index: unknown
  signature: string | Uint8Array
}

export interface ConverterPackReference {
  name: ConverterPackName
  version: string
  platform: ConverterPackPlatform
  arch: ConverterPackArchitecture
}

export interface ConverterPackLease extends ConverterPackReference {
  readonly root: string
  readonly executables: Readonly<Record<string, string>>
  release(): void
}

export type ConverterPackFailureReason =
  | 'root_unavailable'
  | 'signature_invalid'
  | 'index_rollback'
  | 'index_invalid'
  | 'platform_unsupported'
  | 'pack_unavailable'
  | 'download_failed'
  | 'redirect_invalid'
  | 'redirect_limit'
  | 'archive_size_mismatch'
  | 'archive_hash_mismatch'
  | 'archive_entry_invalid'
  | 'entry_hash_mismatch'
  | 'installed_pack_invalid'
  | 'sequence_state_invalid'
  | 'install_failed'

export class ConverterPackError extends Error {
  readonly code = 'CONVERSION_COMPONENT_UNAVAILABLE' as const

  constructor(readonly reason: ConverterPackFailureReason) {
    super('The required conversion component is unavailable.')
    this.name = 'ConverterPackError'
  }
}
