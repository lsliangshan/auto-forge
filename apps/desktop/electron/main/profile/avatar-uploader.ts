import { randomUUID } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  toSafeAppError,
  type AppError,
  type ProfileAvatarUploadResult,
} from '@autoforge/shared'
import { detectMediaType } from '../media/media-sniffer.js'
import type { QiniuFileUploaderPort } from '../upload/qiniu-file-uploader.js'

const AVATAR_MAX_BYTES = 5 * 1024 * 1024
const MAX_SNIFF_BYTES = 64 * 1024
const AVATAR_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])

export interface AvatarUploader {
  pickAndUpload(userId: string): Promise<ProfileAvatarUploadResult | null>
}

export interface QiniuAvatarUploaderOptions {
  chooseAvatar(): Promise<string | undefined>
  upload: QiniuFileUploaderPort
  createId?: () => string
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

async function inspectAvatar(path: string): Promise<{ extension: string; mimeType: string }> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile()) throw failure('MEDIA_TYPE_UNSUPPORTED')
  if (stats.size > AVATAR_MAX_BYTES) throw failure('MEDIA_SIZE_LIMIT_EXCEEDED')

  const handle = await open(path, 'r')
  try {
    const prefix = Buffer.alloc(Math.min(MAX_SNIFF_BYTES, stats.size))
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    const detected = detectMediaType(prefix.subarray(0, bytesRead))
    const extension = detected ? AVATAR_TYPES.get(detected.mimeType) : undefined
    if (!detected || detected.kind !== 'image' || !extension) throw failure('MEDIA_TYPE_UNSUPPORTED')
    const suppliedExtension = extname(path).slice(1).toLowerCase()
    const extensionMatches = suppliedExtension === extension
      || (extension === 'jpg' && suppliedExtension === 'jpeg')
    if (!extensionMatches) throw failure('MEDIA_MIME_MISMATCH')
    return { extension, mimeType: detected.mimeType }
  } finally {
    await handle.close()
  }
}

export class QiniuAvatarUploader implements AvatarUploader {
  private readonly createId: () => string

  constructor(private readonly options: QiniuAvatarUploaderOptions) {
    this.createId = options.createId ?? randomUUID
  }

  async pickAndUpload(userId: string): Promise<ProfileAvatarUploadResult | null> {
    const path = await this.options.chooseAvatar()
    if (!path) return null
    const inspected = await inspectAvatar(path)
    const key = `profiles/${userId}/${this.createId()}.${inspected.extension}`

    try {
      const uploaded = await this.options.upload.uploadFile({
        key,
        localPath: path,
        mimeType: inspected.mimeType,
      })
      return { url: uploaded.url }
    } catch {
      throw failure('PROFILE_AVATAR_UPLOAD_FAILED')
    }
  }
}
