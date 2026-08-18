import { randomUUID } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { extname } from 'node:path'
import {
  appErrorCodeSchema,
  toSafeAppError,
  type AppError,
  type ProfileAvatarUploadResult,
} from '@autoforge/shared'
import qiniu from 'qiniu'
import { detectMediaType } from '../media/media-sniffer.js'

const AVATAR_MAX_BYTES = 5 * 1024 * 1024
const MAX_SNIFF_BYTES = 64 * 1024
const AVATAR_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
])
const QINIU_ZONES = {
  z0: qiniu.zone.Zone_z0,
  cn_east_2: qiniu.zone.Zone_cn_east_2,
  z1: qiniu.zone.Zone_z1,
  z2: qiniu.zone.Zone_z2,
  na0: qiniu.zone.Zone_na0,
  as0: qiniu.zone.Zone_as0,
} as const

export interface QiniuConfig {
  accessKey: string
  secretKey: string
  bucket: string
  domain: string
  region: keyof typeof QINIU_ZONES
}

export interface QiniuUploadPort {
  putFile(input: {
    accessKey: string
    secretKey: string
    bucket: string
    region: QiniuConfig['region']
    key: string
    path: string
    mimeType?: string
  }): Promise<{ key: string }>
}

export interface AvatarUploader {
  pickAndUpload(userId: string): Promise<ProfileAvatarUploadResult | null>
}

export interface QiniuAvatarUploaderOptions {
  chooseAvatar(): Promise<string | undefined>
  config(): QiniuConfig
  upload?: QiniuUploadPort
  createId?: () => string
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

export function readQiniuConfig(env: NodeJS.ProcessEnv): QiniuConfig {
  const accessKey = env.QINIU_ACCESS_KEY?.trim()
  const secretKey = env.QINIU_SECRET_KEY?.trim()
  const bucket = env.QINIU_BUCKET?.trim()
  const domain = env.QINIU_DOMAIN?.trim()
  const region = env.QINIU_REGION?.trim()
  if (!accessKey || !secretKey || !bucket || !domain || !region) {
    throw failure('CREDENTIAL_UNAVAILABLE')
  }

  try {
    const parsed = new URL(domain)
    if (parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
      || (parsed.pathname !== '/' && parsed.pathname !== '')) {
      throw failure('CREDENTIAL_INVALID')
    }
    if (!(region in QINIU_ZONES)) throw failure('CREDENTIAL_INVALID')
    return {
      accessKey,
      secretKey,
      bucket,
      domain: parsed.origin,
      region: region as QiniuConfig['region'],
    }
  } catch (error) {
    const parsedCode = appErrorCodeSchema.safeParse((error as { code?: unknown }).code)
    if (parsedCode.success) throw error
    throw failure('CREDENTIAL_INVALID')
  }
}

class QiniuSdkUploadPort implements QiniuUploadPort {
  async putFile(input: Parameters<QiniuUploadPort['putFile']>[0]): Promise<{ key: string }> {
    const mac = new qiniu.auth.digest.Mac(input.accessKey, input.secretKey)
    const policy = new qiniu.rs.PutPolicy({
      scope: `${input.bucket}:${input.key}`,
      expires: 600,
      insertOnly: 1,
      fsizeLimit: AVATAR_MAX_BYTES,
      mimeLimit: 'image/jpeg;image/png;image/webp',
    })
    const uploader = new qiniu.form_up.FormUploader(new qiniu.conf.Config({
      useHttpsDomain: true,
      zone: QINIU_ZONES[input.region],
    }))
    const result = await uploader.putFile(
      policy.uploadToken(mac),
      input.key,
      input.path,
      new qiniu.form_up.PutExtra('', {}, input.mimeType),
    )
    const key = (result.data as { key?: unknown }).key
    if (typeof key !== 'string') throw new Error('Qiniu upload response is missing the object key')
    return { key }
  }
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
  private readonly upload: QiniuUploadPort
  private readonly createId: () => string

  constructor(private readonly options: QiniuAvatarUploaderOptions) {
    this.upload = options.upload ?? new QiniuSdkUploadPort()
    this.createId = options.createId ?? randomUUID
  }

  async pickAndUpload(userId: string): Promise<ProfileAvatarUploadResult | null> {
    const path = await this.options.chooseAvatar()
    if (!path) return null
    const config = this.options.config()
    const inspected = await inspectAvatar(path)
    const key = `profiles/${userId}/${this.createId()}.${inspected.extension}`

    try {
      const uploaded = await this.upload.putFile({
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        bucket: config.bucket,
        region: config.region,
        key,
        path,
        mimeType: inspected.mimeType,
      })
      if (uploaded.key !== key) throw new Error('Qiniu returned a different object key')
      const encodedKey = key.split('/').map(encodeURIComponent).join('/')
      return { url: `${config.domain}/${encodedKey}` }
    } catch {
      throw failure('PROFILE_AVATAR_UPLOAD_FAILED')
    }
  }
}
