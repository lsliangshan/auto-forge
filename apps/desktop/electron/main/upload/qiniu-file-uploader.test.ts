import { describe, expect, it, vi } from 'vitest'
import {
  QiniuFileUploader,
  readQiniuConfig,
  type QiniuUploadPort,
} from './qiniu-file-uploader.js'

const env = {
  QINIU_ACCESS_KEY: 'access',
  QINIU_SECRET_KEY: 'secret',
  QINIU_BUCKET: 'bucket',
  QINIU_DOMAIN: 'https://cdn.example.com',
  QINIU_DEFAULT_PATH: '/autoforge//',
  QINIU_UPLOAD_URL: 'https://up-z2.qiniup.com',
}

describe('QiniuFileUploader', () => {
  it('reads and normalizes the generic Qiniu configuration', () => {
    expect(readQiniuConfig(env)).toEqual({
      accessKey: 'access',
      secretKey: 'secret',
      bucket: 'bucket',
      domain: 'https://cdn.example.com',
      defaultPath: 'autoforge/',
      uploadUrl: 'https://up-z2.qiniup.com',
    })
  })

  it('rejects missing values and invalid upload URLs', () => {
    expect(() => readQiniuConfig({})).toThrowError(expect.objectContaining({
      code: 'CREDENTIAL_UNAVAILABLE',
    }))
    expect(() => readQiniuConfig({
      ...env,
      QINIU_UPLOAD_URL: 'http://up.example.com',
    })).toThrowError(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  })

  it('prefixes and normalizes the key before using the configured upload URL', async () => {
    const upload: QiniuUploadPort = {
      putFile: vi.fn(async ({ key }) => ({ key, hash: 'hash' })),
    }
    const uploader = new QiniuFileUploader({
      config: () => readQiniuConfig(env),
      upload,
    })

    await expect(uploader.uploadFile({
      localPath: '/tmp/avatar.png',
      key: '../profiles//./user_1/avatar 1.png',
      mimeType: 'image/png',
    })).resolves.toEqual({
      url: 'https://cdn.example.com/autoforge/profiles/user_1/avatar%201.png',
      key: 'autoforge/profiles/user_1/avatar 1.png',
      hash: 'hash',
      bucket: 'bucket',
    })
    expect(upload.putFile).toHaveBeenCalledWith({
      accessKey: 'access',
      secretKey: 'secret',
      bucket: 'bucket',
      uploadUrl: 'https://up-z2.qiniup.com',
      key: 'autoforge/profiles/user_1/avatar 1.png',
      localPath: '/tmp/avatar.png',
      mimeType: 'image/png',
    })
  })

  it('rejects a provider response for a different object key', async () => {
    const upload: QiniuUploadPort = {
      putFile: vi.fn(async () => ({ key: 'different' })),
    }
    const uploader = new QiniuFileUploader({
      config: () => readQiniuConfig(env),
      upload,
    })

    await expect(uploader.uploadFile({
      localPath: '/tmp/file.txt',
      key: 'file.txt',
    })).rejects.toThrow('different object key')
  })
})
