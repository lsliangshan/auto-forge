import {
  appErrorCodeSchema,
  toSafeAppError,
  type AppError,
} from '@autoforge/shared'
import qiniu from 'qiniu'

export interface QiniuConfig {
  accessKey: string
  secretKey: string
  bucket: string
  domain: string
  defaultPath: string
  uploadUrl: string
}

export interface QiniuFileUploadInput {
  localPath: string
  key: string
  mimeType?: string
}

export interface QiniuFileUploadResult {
  url: string
  key: string
  hash?: string
  bucket: string
}

export interface QiniuFileUploaderPort {
  uploadFile(input: QiniuFileUploadInput): Promise<QiniuFileUploadResult>
}

export interface QiniuUploadPort {
  putFile(input: {
    accessKey: string
    secretKey: string
    bucket: string
    uploadUrl: string
    key: string
    localPath: string
    mimeType?: string
  }): Promise<{ key: string; hash?: string }>
}

export interface QiniuFileUploaderOptions {
  config(): QiniuConfig
  upload?: QiniuUploadPort
}

function failure(code: AppError['code']): AppError {
  return toSafeAppError({ code })
}

function normalizeObjectPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..')
    .join('/')
}

function parseHttpsOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw failure('CREDENTIAL_INVALID')
  }
  return parsed.origin
}

export function readQiniuConfig(env: NodeJS.ProcessEnv): QiniuConfig {
  const accessKey = env.QINIU_ACCESS_KEY?.trim()
  const secretKey = env.QINIU_SECRET_KEY?.trim()
  const bucket = env.QINIU_BUCKET?.trim()
  const domain = env.QINIU_DOMAIN?.trim()
  const defaultPath = env.QINIU_DEFAULT_PATH?.trim()
  const uploadUrl = env.QINIU_UPLOAD_URL?.trim()
  if (!accessKey || !secretKey || !bucket || !domain || !defaultPath || !uploadUrl) {
    throw failure('CREDENTIAL_UNAVAILABLE')
  }

  try {
    const normalizedPath = normalizeObjectPath(defaultPath)
    return {
      accessKey,
      secretKey,
      bucket,
      domain: parseHttpsOrigin(domain),
      defaultPath: normalizedPath ? `${normalizedPath}/` : '',
      uploadUrl: parseHttpsOrigin(uploadUrl),
    }
  } catch (error) {
    const parsedCode = appErrorCodeSchema.safeParse((error as { code?: unknown }).code)
    if (parsedCode.success) throw error
    throw failure('CREDENTIAL_INVALID')
  }
}

class QiniuSdkUploadPort implements QiniuUploadPort {
  async putFile(input: Parameters<QiniuUploadPort['putFile']>[0]): Promise<{ key: string; hash?: string }> {
    const mac = new qiniu.auth.digest.Mac(input.accessKey, input.secretKey)
    const policy = new qiniu.rs.PutPolicy({
      scope: `${input.bucket}:${input.key}`,
      expires: 600,
      insertOnly: 1,
    })
    const uploadHost = new URL(input.uploadUrl).host
    const uploader = new qiniu.form_up.FormUploader(new qiniu.conf.Config({
      useHttpsDomain: true,
      zone: new qiniu.conf.Zone([uploadHost]),
    }))
    const result = await uploader.putFile(
      policy.uploadToken(mac),
      input.key,
      input.localPath,
      new qiniu.form_up.PutExtra('', {}, input.mimeType),
    )
    const data = result.data as { key?: unknown; hash?: unknown }
    if (typeof data.key !== 'string') throw new Error('Qiniu upload response is missing the object key')
    return {
      key: data.key,
      ...(typeof data.hash === 'string' ? { hash: data.hash } : {}),
    }
  }
}

export class QiniuFileUploader implements QiniuFileUploaderPort {
  private readonly upload: QiniuUploadPort

  constructor(private readonly options: QiniuFileUploaderOptions) {
    this.upload = options.upload ?? new QiniuSdkUploadPort()
  }

  async uploadFile(input: QiniuFileUploadInput): Promise<QiniuFileUploadResult> {
    const config = this.options.config()
    const key = normalizeObjectPath(`${config.defaultPath}/${input.key}`)
    if (!key) throw new Error('Qiniu object key is unavailable')
    const uploaded = await this.upload.putFile({
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      bucket: config.bucket,
      uploadUrl: config.uploadUrl,
      key,
      localPath: input.localPath,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    })
    if (uploaded.key !== key) throw new Error('Qiniu returned a different object key')
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')
    return {
      url: `${config.domain}/${encodedKey}`,
      key,
      ...(uploaded.hash ? { hash: uploaded.hash } : {}),
      bucket: config.bucket,
    }
  }
}
