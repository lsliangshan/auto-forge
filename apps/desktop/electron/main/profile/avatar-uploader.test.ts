import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toSafeAppError } from '@autoforge/shared'
import {
  QiniuAvatarUploader,
  readQiniuConfig,
  type QiniuUploadPort,
} from './avatar-uploader.js'

const directories: string[] = []

function fixture(name: string, bytes: Uint8Array): string {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-avatar-'))
  directories.push(directory)
  const path = join(directory, name)
  writeFileSync(path, bytes)
  return path
}

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])

function harness(path?: string, uploadError?: Error) {
  const upload: QiniuUploadPort = {
    putFile: vi.fn(async ({ key }) => {
      if (uploadError) throw uploadError
      return { key }
    }),
  }
  const uploader = new QiniuAvatarUploader({
    chooseAvatar: vi.fn(async () => path),
    config: () => ({
      accessKey: 'access',
      secretKey: 'secret',
      bucket: 'bucket',
      domain: 'https://cdn.example.com',
      region: 'z0',
    }),
    upload,
    createId: () => 'avatar-id',
  })
  return { upload, uploader }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('QiniuAvatarUploader', () => {
  it('returns null when the chooser is cancelled', async () => {
    const app = harness()

    await expect(app.uploader.pickAndUpload('user_1')).resolves.toBeNull()
    expect(app.upload.putFile).not.toHaveBeenCalled()
  })

  it('uploads a sniffed image under a random user-scoped key', async () => {
    const path = fixture('avatar.png', png)
    const app = harness(path)

    await expect(app.uploader.pickAndUpload('user_1')).resolves.toEqual({
      url: 'https://cdn.example.com/profiles/user_1/avatar-id.png',
    })
    expect(app.upload.putFile).toHaveBeenCalledWith({
      accessKey: 'access',
      secretKey: 'secret',
      bucket: 'bucket',
      region: 'z0',
      key: 'profiles/user_1/avatar-id.png',
      path,
      mimeType: 'image/png',
    })
  })

  it('accepts jpeg as either jpg or jpeg', async () => {
    await expect(harness(fixture('avatar.jpg', jpeg)).uploader.pickAndUpload('user_1'))
      .resolves.toMatchObject({ url: expect.stringMatching(/\.jpg$/) })
    await expect(harness(fixture('avatar.jpeg', jpeg)).uploader.pickAndUpload('user_1'))
      .resolves.toMatchObject({ url: expect.stringMatching(/\.jpg$/) })
  })

  it('rejects missing or invalid Qiniu configuration', () => {
    expect(() => readQiniuConfig({})).toThrowError(expect.objectContaining({ code: 'CREDENTIAL_UNAVAILABLE' }))
    expect(() => readQiniuConfig({
      QINIU_ACCESS_KEY: 'access',
      QINIU_SECRET_KEY: 'secret',
      QINIU_BUCKET: 'bucket',
      QINIU_DOMAIN: 'http://cdn.example.com',
      QINIU_REGION: 'z0',
    })).toThrowError(expect.objectContaining({ code: 'CREDENTIAL_INVALID' }))
  })

  it('rejects oversized, unsupported and mismatched image files', async () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1)
    oversized.set(png)
    await expect(harness(fixture('large.png', oversized)).uploader.pickAndUpload('user_1'))
      .rejects.toMatchObject({ code: 'MEDIA_SIZE_LIMIT_EXCEEDED' })
    await expect(harness(fixture('avatar.png', new TextEncoder().encode('plain text'))).uploader.pickAndUpload('user_1'))
      .rejects.toMatchObject({ code: 'MEDIA_TYPE_UNSUPPORTED' })
    await expect(harness(fixture('avatar.png', jpeg)).uploader.pickAndUpload('user_1'))
      .rejects.toMatchObject({ code: 'MEDIA_MIME_MISMATCH' })
  })

  it('maps Qiniu failures to one safe profile error', async () => {
    const app = harness(fixture('avatar.png', png), new Error('provider response with token'))

    await expect(app.uploader.pickAndUpload('user_1'))
      .rejects.toEqual(toSafeAppError({ code: 'PROFILE_AVATAR_UPLOAD_FAILED' }))
  })
})
