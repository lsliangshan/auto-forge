import { randomUUID } from 'node:crypto'
import type { Dirent, RmOptions, Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { toSafeAppError, type AppError } from '@autoforge/shared'
import type {
  Conversation,
  MediaAssetPatch,
  MediaAssetRecord,
} from '../database/repositories.js'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const DAY = 24 * 60 * 60 * 1_000
const MANAGED_EXTENSIONS = [
  'png', 'jpg', 'webp', 'gif', 'avif', 'svg',
  'mp3', 'wav', 'ogg', 'flac', 'm4a',
  'mp4', 'webm', 'mov',
] as const

interface ConversationRepository {
  get(id: string): Conversation | undefined
  list(): Conversation[]
  delete(id: string): void
}

interface MediaAssetRepository {
  get(id: string): MediaAssetRecord | undefined
  listForConversation(conversationId: string): MediaAssetRecord[]
  listUnclaimedBefore(timestamp: number): MediaAssetRecord[]
  update(id: string, patch: MediaAssetPatch): MediaAssetRecord | undefined
  delete(id: string): void
}

export interface MediaLifecycleDatabase {
  conversations: ConversationRepository
  mediaAssets: MediaAssetRepository
  clearConversations(): void
}

export interface MediaLifecycleFileSystem {
  lstat(path: string): Promise<Stats>
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  realpath(path: string): Promise<string>
  rename(source: string, destination: string): Promise<void>
  rm(path: string, options: RmOptions): Promise<void>
}

export interface MediaLifecycleOptions {
  database: MediaLifecycleDatabase
  mediaRoot: string
  now?: () => number
  filesystem?: Partial<MediaLifecycleFileSystem>
}

interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface QuarantinedConversation {
  conversationId: string
  source: string
  quarantine: string
}

type CanonicalCandidate =
  | { state: 'absent' }
  | { state: 'unsafe' }
  | { state: 'file'; path: string; identity: FileIdentity }

const nodeFileSystem: MediaLifecycleFileSystem = {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

function isAppError(error: unknown): error is AppError {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'message' in error
}

function missing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

function snapshot(metadata: Stats): FileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  }
}

function sameNode(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return sameNode(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

export class MediaLifecycle {
  private readonly database: MediaLifecycleDatabase
  private readonly filesystem: MediaLifecycleFileSystem
  private readonly configuredRoot: string
  private mediaRoot: string
  private quarantineRoot: string
  private readonly now: () => number

  constructor(options: MediaLifecycleOptions) {
    this.database = options.database
    this.filesystem = { ...nodeFileSystem, ...options.filesystem }
    this.configuredRoot = resolve(options.mediaRoot)
    this.mediaRoot = this.configuredRoot
    this.quarantineRoot = join(this.mediaRoot, '.quarantine')
    this.now = options.now ?? Date.now
  }

  async deleteConversation(conversationId: string): Promise<void> {
    try {
      this.assertIdentifier(conversationId)
      const quarantined = await this.quarantineConversation(conversationId)
      try {
        this.database.conversations.delete(conversationId)
      } catch (error) {
        let committed = false
        try {
          committed = this.database.conversations.get(conversationId) === undefined
        } catch {
          // Database authority could not be re-read; restore conservatively.
        }
        if (committed) {
          if (quarantined) await this.tryPurge(quarantined.quarantine)
          return
        }
        if (quarantined && !await this.restoreConversation(quarantined)) {
          this.markReadyAssetsMissingFailed(conversationId)
        }
        throw error
      }
      if (quarantined) await this.tryPurge(quarantined.quarantine)
    } catch (error) {
      if (isAppError(error)) throw error
      throw failure('INTERNAL_ERROR')
    }
  }

  async clearConversations(): Promise<void> {
    try {
      const quarantined: QuarantinedConversation[] = []
      const conversations = this.database.conversations.list()
      try {
        for (const conversation of conversations) {
          this.assertIdentifier(conversation.id)
          const entry = await this.quarantineConversation(conversation.id)
          if (entry) quarantined.push(entry)
        }
      } catch (error) {
        await this.restoreAll(quarantined)
        throw error
      }

      try {
        this.database.clearConversations()
      } catch (error) {
        const live = new Set<string>()
        let authorityKnown = true
        for (const conversation of conversations) {
          try {
            if (this.database.conversations.get(conversation.id)) {
              live.add(conversation.id)
            }
          } catch {
            authorityKnown = false
            break
          }
        }
        if (!authorityKnown) {
          await this.restoreAll(quarantined)
          throw error
        }
        for (const entry of quarantined) {
          if (live.has(entry.conversationId)) {
            if (!await this.restoreConversation(entry)) {
              this.markReadyAssetsMissingFailed(entry.conversationId)
            }
          } else {
            await this.tryPurge(entry.quarantine)
          }
        }
        if (live.size === 0) return
        throw error
      }

      for (const entry of quarantined) await this.tryPurge(entry.quarantine)
    } catch (error) {
      if (isAppError(error)) throw error
      throw failure('INTERNAL_ERROR')
    }
  }

  async recover(): Promise<void> {
    try {
      await this.ensureRoots()
      await this.recoverConversationQuarantines()

      for (const conversation of this.database.conversations.list()) {
        if (!ID_PATTERN.test(conversation.id)) continue
        await this.recoverConversationAssets(conversation.id)
        await this.cleanStaging(conversation.id)
      }

      await this.cleanOldUnclaimed()
      await this.cleanOrphanTombstones()
      await this.cleanDeletedConversationDirectories()
    } catch (error) {
      if (isAppError(error)) throw error
      throw failure('INTERNAL_ERROR')
    }
  }

  private assertIdentifier(value: string): void {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw failure('INVALID_INPUT')
  }

  private async metadata(path: string): Promise<Stats | undefined> {
    try {
      return await this.filesystem.lstat(path)
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  }

  private async verifyDirectory(path: string, expected?: FileIdentity): Promise<FileIdentity> {
    const metadata = await this.filesystem.lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw failure('MEDIA_IMPORT_FAILED')
    if (await this.filesystem.realpath(path) !== path) throw failure('MEDIA_IMPORT_FAILED')
    const identity = snapshot(metadata)
    if (expected && !sameNode(expected, identity)) throw failure('MEDIA_IMPORT_FAILED')
    return identity
  }

  private async verifyFile(path: string, expected?: FileIdentity): Promise<FileIdentity> {
    const metadata = await this.filesystem.lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw failure('MEDIA_IMPORT_FAILED')
    if (await this.filesystem.realpath(path) !== path) throw failure('MEDIA_IMPORT_FAILED')
    const identity = snapshot(metadata)
    if (expected && !sameFile(expected, identity)) throw failure('MEDIA_IMPORT_FAILED')
    return identity
  }

  private async ensureRoots(): Promise<{ root: FileIdentity; quarantine: FileIdentity }> {
    const configuredMetadata = await this.metadata(this.configuredRoot)
    if (configuredMetadata?.isSymbolicLink()) throw failure('MEDIA_IMPORT_FAILED')
    if (!configuredMetadata) await this.filesystem.mkdir(this.configuredRoot, { recursive: true })
    const safeConfiguredMetadata = await this.filesystem.lstat(this.configuredRoot)
    if (safeConfiguredMetadata.isSymbolicLink() || !safeConfiguredMetadata.isDirectory()) {
      throw failure('MEDIA_IMPORT_FAILED')
    }
    const canonicalRoot = await this.filesystem.realpath(this.configuredRoot)
    this.mediaRoot = canonicalRoot
    this.quarantineRoot = join(canonicalRoot, '.quarantine')
    const root = await this.verifyDirectory(this.mediaRoot)
    await this.filesystem.mkdir(this.quarantineRoot, { recursive: true })
    const quarantine = await this.verifyDirectory(this.quarantineRoot)
    await this.verifyDirectory(this.mediaRoot, root)
    return { root, quarantine }
  }

  private async verifyTree(path: string): Promise<void> {
    const metadata = await this.filesystem.lstat(path)
    if (metadata.isSymbolicLink()) throw failure('MEDIA_IMPORT_FAILED')
    if (metadata.isFile()) {
      if (await this.filesystem.realpath(path) !== path) throw failure('MEDIA_IMPORT_FAILED')
      return
    }
    if (!metadata.isDirectory() || await this.filesystem.realpath(path) !== path) {
      throw failure('MEDIA_IMPORT_FAILED')
    }
    for (const entry of await this.filesystem.readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw failure('MEDIA_IMPORT_FAILED')
      await this.verifyTree(join(path, entry.name))
    }
  }

  private async quarantineConversation(
    conversationId: string,
  ): Promise<QuarantinedConversation | undefined> {
    const roots = await this.ensureRoots()
    const source = join(this.mediaRoot, conversationId)
    const quarantine = join(this.quarantineRoot, `${conversationId}.deleting`)
    const sourceMetadata = await this.metadata(source)
    if (!sourceMetadata) return undefined
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isDirectory()) {
      throw failure('MEDIA_IMPORT_FAILED')
    }
    if (await this.metadata(quarantine)) throw failure('CONFLICT')
    const sourceIdentity = await this.verifyDirectory(source)
    await this.verifyTree(source)
    await this.verifyDirectory(this.mediaRoot, roots.root)
    await this.verifyDirectory(this.quarantineRoot, roots.quarantine)
    await this.verifyDirectory(source, sourceIdentity)
    const entry = { conversationId, source, quarantine }
    try {
      await this.filesystem.rename(source, quarantine)
      const movedIdentity = await this.verifyDirectory(quarantine)
      if (!sameNode(sourceIdentity, movedIdentity)) throw failure('MEDIA_IMPORT_FAILED')
      if (await this.metadata(source)) throw failure('MEDIA_IMPORT_FAILED')
      await this.verifyTree(quarantine)
      await this.verifyDirectory(this.mediaRoot, roots.root)
      await this.verifyDirectory(this.quarantineRoot, roots.quarantine)
      return entry
    } catch (error) {
      try {
        if (!await this.metadata(source) && await this.metadata(quarantine)) {
          if (!await this.restoreConversation(entry)) {
            this.markReadyAssetsMissingFailed(conversationId)
          }
        }
      } catch {
        this.markReadyAssetsMissingFailed(conversationId)
      }
      throw error
    }
  }

  private async restoreConversation(entry: QuarantinedConversation): Promise<boolean> {
    try {
      const roots = await this.ensureRoots()
      if (await this.metadata(entry.source)) return false
      const quarantineIdentity = await this.verifyDirectory(entry.quarantine)
      await this.verifyTree(entry.quarantine)
      await this.verifyDirectory(this.mediaRoot, roots.root)
      await this.verifyDirectory(this.quarantineRoot, roots.quarantine)
      await this.filesystem.rename(entry.quarantine, entry.source)
      const restoredIdentity = await this.verifyDirectory(entry.source)
      if (!sameNode(quarantineIdentity, restoredIdentity)) return false
      if (await this.metadata(entry.quarantine)) return false
      await this.verifyTree(entry.source)
      await this.verifyDirectory(this.mediaRoot, roots.root)
      return true
    } catch {
      return false
    }
  }

  private async restoreAll(entries: QuarantinedConversation[]): Promise<void> {
    for (const entry of [...entries].reverse()) {
      if (!await this.restoreConversation(entry)) {
        this.markReadyAssetsMissingFailed(entry.conversationId)
      }
    }
  }

  private markReadyAssetsMissingFailed(conversationId: string): void {
    for (const asset of this.database.mediaAssets.listForConversation(conversationId)) {
      if (asset.status !== 'ready') continue
      try {
        this.database.mediaAssets.update(asset.id, {
          status: 'failed',
          updatedAt: this.now(),
        })
      } catch {
        // A later startup recovery repeats this reconciliation while the tombstone remains.
      }
    }
  }

  private async tryPurge(path: string): Promise<boolean> {
    try {
      const roots = await this.ensureRoots()
      const metadata = await this.metadata(path)
      if (!metadata) return true
      if (metadata.isSymbolicLink()) return false
      await this.verifyTree(path)
      await this.verifyDirectory(this.mediaRoot, roots.root)
      await this.verifyDirectory(this.quarantineRoot, roots.quarantine)
      await this.filesystem.rm(path, { recursive: metadata.isDirectory(), force: false })
      return !await this.metadata(path)
    } catch {
      return false
    }
  }

  private async recoverConversationQuarantines(): Promise<void> {
    for (const entry of await this.filesystem.readdir(this.quarantineRoot, { withFileTypes: true })) {
      if (!entry.name.endsWith('.deleting')) continue
      const conversationId = entry.name.slice(0, -'.deleting'.length)
      if (!ID_PATTERN.test(conversationId) || entry.isSymbolicLink() || !entry.isDirectory()) continue
      const item = {
        conversationId,
        source: join(this.mediaRoot, conversationId),
        quarantine: join(this.quarantineRoot, entry.name),
      }
      if (this.database.conversations.get(conversationId)) {
        if (!await this.restoreConversation(item)) this.markReadyAssetsMissingFailed(conversationId)
      } else {
        await this.tryPurge(item.quarantine)
      }
    }
  }

  private canonicalAssetPath(asset: MediaAssetRecord): string | undefined {
    if (!asset.relativePath || isAbsolute(asset.relativePath)) return undefined
    const normalized = posix.normalize(asset.relativePath)
    if (normalized !== asset.relativePath || normalized.startsWith('../')) return undefined
    const parts = normalized.split('/')
    if (parts.length !== 2 || parts[0] !== asset.conversationId || !parts[1]) return undefined
    const path = resolve(this.mediaRoot, ...parts)
    return path.startsWith(`${this.mediaRoot}${sep}`) ? path : undefined
  }

  private tombstonePath(asset: MediaAssetRecord): string | undefined {
    if (!asset.relativePath || isAbsolute(asset.relativePath)) return undefined
    const normalized = posix.normalize(asset.relativePath)
    const parts = normalized.split('/')
    if (
      normalized !== asset.relativePath
      || parts.length !== 2
      || parts[0] !== '.quarantine'
      || !parts[1]?.endsWith('.delete')
      || basename(parts[1]) !== parts[1]
    ) return undefined
    return join(this.quarantineRoot, parts[1])
  }

  private async isSafeFile(path: string): Promise<boolean> {
    const metadata = await this.metadata(path)
    if (!metadata) return false
    await this.verifyFile(path)
    return true
  }

  private async recoverConversationAssets(conversationId: string): Promise<void> {
    for (const asset of this.database.mediaAssets.listForConversation(conversationId)) {
      const tombstone = this.tombstonePath(asset)
      if (asset.status !== 'ready' && tombstone) {
        await this.recoverNonReadyTombstoneAsset(asset, tombstone)
        continue
      }
      if (asset.status !== 'ready') continue
      const path = this.canonicalAssetPath(asset)
      let available: boolean
      try {
        available = Boolean(path) && await this.isSafeFile(path!)
      } catch {
        available = false
      }
      if (!available) {
        try {
          this.database.mediaAssets.update(asset.id, {
            status: 'failed',
            updatedAt: this.now(),
          })
        } catch {
          // Keep recovery per-entry; the database remains authoritative on retry.
        }
      }
    }
  }

  private async recoverNonReadyTombstoneAsset(
    asset: MediaAssetRecord,
    tombstone: string,
  ): Promise<void> {
    if (await this.metadata(tombstone)) {
      if (!await this.tryPurge(tombstone)) return
    } else {
      const candidate = await this.findCanonicalCandidate(asset)
      if (candidate.state === 'unsafe') return
      if (
        candidate.state === 'file'
        && !await this.moveCanonicalBackToTombstone(
          candidate.path,
          candidate.identity,
          tombstone,
        )
      ) return
      if (candidate.state === 'file' && !await this.tryPurge(tombstone)) return
    }

    if (await this.metadata(tombstone)) return
    if ((await this.findCanonicalCandidate(asset)).state !== 'absent') return
    try {
      this.database.mediaAssets.delete(asset.id)
    } catch {
      // No managed bytes remain; a retained non-ready row is safe to retry.
    }
  }

  private async findCanonicalCandidate(asset: MediaAssetRecord): Promise<CanonicalCandidate> {
    if (!ID_PATTERN.test(asset.id) || !ID_PATTERN.test(asset.conversationId)) {
      return { state: 'unsafe' }
    }
    const directory = join(this.mediaRoot, asset.conversationId)
    const directoryMetadata = await this.metadata(directory)
    if (!directoryMetadata) return { state: 'absent' }
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      return { state: 'unsafe' }
    }
    try {
      const directoryIdentity = await this.verifyDirectory(directory)
      const expectedNames = new Set(
        MANAGED_EXTENSIONS.map((extension) => `${asset.id}.${extension}`),
      )
      const matches = (await this.filesystem.readdir(directory, { withFileTypes: true }))
        .filter((entry) => expectedNames.has(entry.name))
      if (matches.length === 0) return { state: 'absent' }
      if (
        matches.length !== 1
        || matches[0]!.isSymbolicLink()
        || !matches[0]!.isFile()
      ) return { state: 'unsafe' }
      const path = join(directory, matches[0]!.name)
      const identity = await this.verifyFile(path)
      await this.verifyDirectory(directory, directoryIdentity)
      return { state: 'file', path, identity }
    } catch {
      return { state: 'unsafe' }
    }
  }

  private async cleanStaging(conversationId: string): Promise<void> {
    const directory = join(this.mediaRoot, conversationId, '.staging')
    const metadata = await this.metadata(directory)
    if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) return
    try {
      await this.verifyDirectory(join(this.mediaRoot, conversationId))
      await this.verifyDirectory(directory)
    } catch {
      return
    }
    for (const entry of await this.filesystem.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue
      await this.tryPurge(join(directory, entry.name))
    }
  }

  private async cleanOldUnclaimed(): Promise<void> {
    for (const asset of this.database.mediaAssets.listUnclaimedBefore(this.now() - DAY)) {
      const current = this.database.mediaAssets.get(asset.id)
      if (!current || current.messageId) continue
      try {
        await this.removeUnclaimedAsset(current)
      } catch {
        // Recovery is per-entry; one unavailable row must not block later cleanup.
      }
    }
  }

  private async removeUnclaimedAsset(asset: MediaAssetRecord): Promise<void> {
    const existingTombstone = this.tombstonePath(asset)
    if (existingTombstone) {
      if (asset.status !== 'ready') {
        await this.recoverNonReadyTombstoneAsset(asset, existingTombstone)
        return
      }
      if (await this.tryPurge(existingTombstone)) {
        try {
          this.database.mediaAssets.delete(asset.id)
        } catch {
          // The row stays non-ready and is retried on startup.
        }
      }
      return
    }

    const originalPath = this.canonicalAssetPath(asset)
    if (!originalPath) {
      if (asset.status === 'ready') {
        this.database.mediaAssets.update(asset.id, { status: 'failed', updatedAt: this.now() })
      } else {
        this.database.mediaAssets.delete(asset.id)
      }
      return
    }

    let originalIdentity: FileIdentity | undefined
    try {
      originalIdentity = await this.verifyFile(originalPath)
    } catch (error) {
      if (!missing(error)) {
        if (asset.status === 'ready') {
          this.database.mediaAssets.update(asset.id, { status: 'failed', updatedAt: this.now() })
        }
        return
      }
    }
    if (!originalIdentity) {
      if (asset.status === 'ready') {
        this.database.mediaAssets.update(asset.id, { status: 'failed', updatedAt: this.now() })
      }
      this.database.mediaAssets.delete(asset.id)
      return
    }

    const roots = await this.ensureRoots()
    const tombstoneName = `${randomUUID()}.delete`
    const tombstone = join(this.quarantineRoot, tombstoneName)
    const tombstoneRelativePath = posix.join('.quarantine', tombstoneName)
    let deleting: MediaAssetRecord | undefined
    try {
      deleting = this.database.mediaAssets.update(asset.id, {
        status: 'deleting',
        relativePath: tombstoneRelativePath,
        updatedAt: this.now(),
      })
    } catch {
      try {
        deleting = this.database.mediaAssets.get(asset.id)
      } catch {
        return
      }
    }
    if (
      !deleting
      || deleting.messageId
      || deleting.conversationId !== asset.conversationId
      || deleting.status !== 'deleting'
      || deleting.relativePath !== tombstoneRelativePath
    ) return

    try {
      await this.verifyDirectory(this.mediaRoot, roots.root)
      await this.verifyDirectory(this.quarantineRoot, roots.quarantine)
      await this.verifyFile(originalPath, originalIdentity)
      await this.filesystem.rename(originalPath, tombstone)
      const quarantinedIdentity = await this.verifyFile(tombstone)
      if (
        !sameNode(originalIdentity, quarantinedIdentity)
        || originalIdentity.size !== quarantinedIdentity.size
      ) throw failure('MEDIA_IMPORT_FAILED')
      if (await this.metadata(originalPath)) throw failure('MEDIA_IMPORT_FAILED')
    } catch {
      await this.restoreUnclaimedAsset(asset, originalPath, originalIdentity, tombstone, tombstoneRelativePath)
      return
    }

    try {
      this.database.mediaAssets.delete(asset.id)
    } catch {
      let authoritative: MediaAssetRecord | undefined
      try {
        authoritative = this.database.mediaAssets.get(asset.id)
      } catch {
        return
      }
      if (authoritative) {
        await this.restoreUnclaimedAsset(asset, originalPath, originalIdentity, tombstone, tombstoneRelativePath)
        return
      }
    }
    await this.tryPurge(tombstone)
  }

  private async restoreUnclaimedAsset(
    asset: MediaAssetRecord,
    originalPath: string,
    originalIdentity: FileIdentity,
    tombstone: string,
    tombstoneRelativePath: string,
  ): Promise<void> {
    let restored: boolean
    try {
      if (!await this.metadata(originalPath) && await this.metadata(tombstone)) {
        await this.filesystem.rename(tombstone, originalPath)
      }
      const restoredIdentity = await this.verifyFile(originalPath)
      restored = sameNode(originalIdentity, restoredIdentity)
        && originalIdentity.size === restoredIdentity.size
    } catch {
      restored = false
    }

    try {
      this.database.mediaAssets.update(asset.id, {
        status: restored ? asset.status : 'failed',
        relativePath: restored ? asset.relativePath : tombstoneRelativePath,
        updatedAt: this.now(),
      })
    } catch {
      // The durable result is resolved by the authoritative reread below.
    }

    let authoritative: MediaAssetRecord | undefined
    try {
      authoritative = this.database.mediaAssets.get(asset.id)
    } catch {
      authoritative = undefined
    }
    if (restored && this.matchesOriginalAsset(authoritative, asset)) return

    if (restored && !await this.moveCanonicalBackToTombstone(
      originalPath,
      originalIdentity,
      tombstone,
    )) {
      await this.reconcileCanonicalNonReady(asset, originalPath)
      return
    }

    await this.reconcileTombstoneAuthority(
      asset,
      originalIdentity,
      originalPath,
      tombstone,
      tombstoneRelativePath,
      authoritative,
    )
  }

  private matchesOriginalAsset(
    authoritative: MediaAssetRecord | undefined,
    original: MediaAssetRecord,
  ): boolean {
    return Boolean(
      authoritative
      && authoritative.conversationId === original.conversationId
      && authoritative.messageId === original.messageId
      && authoritative.status === original.status
      && authoritative.relativePath === original.relativePath,
    )
  }

  private matchesTombstoneAsset(
    authoritative: MediaAssetRecord | undefined,
    asset: MediaAssetRecord,
    tombstoneRelativePath: string,
  ): boolean {
    return Boolean(
      authoritative
      && authoritative.conversationId === asset.conversationId
      && !authoritative.messageId
      && authoritative.status !== 'ready'
      && authoritative.relativePath === tombstoneRelativePath,
    )
  }

  private async moveCanonicalBackToTombstone(
    originalPath: string,
    originalIdentity: FileIdentity,
    tombstone: string,
  ): Promise<boolean> {
    try {
      const existingTombstone = await this.metadata(tombstone)
      if (existingTombstone) {
        const tombstoneIdentity = await this.verifyFile(tombstone)
        if (
          !sameNode(originalIdentity, tombstoneIdentity)
          || originalIdentity.size !== tombstoneIdentity.size
        ) return false
        if (await this.metadata(originalPath) && !await this.tryPurge(originalPath)) return false
        return true
      }
      const canonicalIdentity = await this.verifyFile(originalPath)
      if (
        !sameNode(originalIdentity, canonicalIdentity)
        || originalIdentity.size !== canonicalIdentity.size
      ) return false
      await this.filesystem.rename(originalPath, tombstone)
      const tombstoneIdentity = await this.verifyFile(tombstone)
      return (
        sameNode(originalIdentity, tombstoneIdentity)
        && originalIdentity.size === tombstoneIdentity.size
        && !await this.metadata(originalPath)
      )
    } catch {
      return false
    }
  }

  private async reconcileCanonicalNonReady(
    asset: MediaAssetRecord,
    originalPath: string,
  ): Promise<void> {
    try {
      this.database.mediaAssets.update(asset.id, {
        status: 'failed',
        relativePath: asset.relativePath,
        updatedAt: this.now(),
      })
    } catch {
      // The authoritative reread below decides whether canonical bytes may remain.
    }
    let authoritative: MediaAssetRecord | undefined
    try {
      authoritative = this.database.mediaAssets.get(asset.id)
    } catch {
      throw failure('INTERNAL_ERROR')
    }
    if (!authoritative) {
      await this.tryPurge(originalPath)
      return
    }
    if (
      authoritative.conversationId === asset.conversationId
      && authoritative.relativePath === asset.relativePath
      && (
        authoritative.status !== 'ready'
        || this.matchesOriginalAsset(authoritative, asset)
      )
    ) return
    throw failure('INTERNAL_ERROR')
  }

  private async reconcileTombstoneAuthority(
    asset: MediaAssetRecord,
    originalIdentity: FileIdentity,
    originalPath: string,
    tombstone: string,
    tombstoneRelativePath: string,
    authorityBeforeMove: MediaAssetRecord | undefined,
  ): Promise<void> {
    let authoritative = authorityBeforeMove
    if (!authoritative) {
      try {
        authoritative = this.database.mediaAssets.get(asset.id)
      } catch {
        throw failure('INTERNAL_ERROR')
      }
    }
    if (!authoritative) {
      await this.tryPurge(tombstone)
      return
    }
    if (this.matchesTombstoneAsset(authoritative, asset, tombstoneRelativePath)) return

    try {
      this.database.mediaAssets.update(asset.id, {
        status: 'failed',
        relativePath: tombstoneRelativePath,
        updatedAt: this.now(),
      })
    } catch {
      // Resolve an acknowledgement loss through the authoritative reread.
    }
    try {
      authoritative = this.database.mediaAssets.get(asset.id)
    } catch {
      throw failure('INTERNAL_ERROR')
    }
    if (!authoritative) {
      await this.tryPurge(tombstone)
      return
    }
    if (this.matchesTombstoneAsset(authoritative, asset, tombstoneRelativePath)) return
    if (this.matchesOriginalAsset(authoritative, asset)) {
      try {
        if (!await this.metadata(originalPath)) {
          await this.filesystem.rename(tombstone, originalPath)
        }
        const restoredIdentity = await this.verifyFile(originalPath)
        if (
          sameNode(originalIdentity, restoredIdentity)
          && originalIdentity.size === restoredIdentity.size
        ) return
      } catch {
        // Fall through to the fixed safe failure below.
      }
    }
    throw failure('INTERNAL_ERROR')
  }

  private async cleanOrphanTombstones(): Promise<void> {
    const claimed = new Set<string>()
    for (const conversation of this.database.conversations.list()) {
      for (const asset of this.database.mediaAssets.listForConversation(conversation.id)) {
        const tombstone = this.tombstonePath(asset)
        if (tombstone) claimed.add(basename(tombstone))
      }
    }
    for (const entry of await this.filesystem.readdir(this.quarantineRoot, { withFileTypes: true })) {
      if (
        claimed.has(entry.name)
        || !entry.name.endsWith('.delete')
        || entry.isSymbolicLink()
        || !entry.isFile()
      ) continue
      await this.tryPurge(join(this.quarantineRoot, entry.name))
    }
  }

  private async cleanDeletedConversationDirectories(): Promise<void> {
    for (const entry of await this.filesystem.readdir(this.mediaRoot, { withFileTypes: true })) {
      if (
        entry.name === '.quarantine'
        || !ID_PATTERN.test(entry.name)
        || entry.isSymbolicLink()
        || !entry.isDirectory()
        || this.database.conversations.get(entry.name)
      ) continue
      await this.tryPurge(join(this.mediaRoot, entry.name))
    }
  }
}
