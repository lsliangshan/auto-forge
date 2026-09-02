import { createHash } from 'node:crypto'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  materializeLockedEngineAssets, openLockedEngineAssets,
} from '../../scripts/converter-packs/locked-engine-assets.mjs'

const roots: string[] = []
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-engine-assets-')))
  roots.push(root)
  return root
}

function fixture(root: string) {
  const dmgBytes = Buffer.from('locked dmg')
  const licenseBytes = Buffer.from('locked license')
  const acquisition = {
    kind: 'dmg', url: 'https://downloads.example.test/libreoffice.dmg',
    sha256: sha256(dmgBytes), bytes: dmgBytes.byteLength, cellar: null,
  }
  const sourceLicense = {
    kind: 'download', url: 'https://downloads.example.test/libreoffice-LICENSE',
    sha256: sha256(licenseBytes), bytes: licenseBytes.byteLength, destination: 'licenses/libreoffice.LICENSE',
  }
  const asset = {
    engine: 'libreoffice', source: 'acquisition', destination: 'share/LibreOffice.dmg',
    sha256: acquisition.sha256, bytes: acquisition.bytes, executable: false, role: 'data',
  }
  const license = {
    engine: 'libreoffice', source: sourceLicense.url, destination: sourceLicense.destination,
    sha256: sourceLicense.sha256, bytes: sourceLicense.bytes,
  }
  const empty = { files: [], rewrites: [], licenses: [], nativeHelpers: [], engineAssets: [], engineLicenses: [] }
  const sourceLock = {
    target: 'darwin-arm64',
    engines: [{ name: 'libreoffice', acquisition, licenses: [sourceLicense] }],
  }
  const closureLock = {
    target: 'darwin-arm64',
    families: {
      'image-icon': structuredClone(empty),
      document: { ...structuredClone(empty), engineAssets: [asset], engineLicenses: [license] },
      pdf: structuredClone(empty),
      media: structuredClone(empty),
    },
  }
  const blobs = new Map()
  for (const [bytes, coordinate] of [[dmgBytes, acquisition], [licenseBytes, sourceLicense]] as const) {
    const path = join(root, `${coordinate.sha256}.blob`)
    writeFileSync(path, bytes)
    blobs.set(coordinate.sha256, { path, sha256: coordinate.sha256, bytes: coordinate.bytes })
  }
  return { sourceLock, closureLock, blobs, asset, license }
}

describe('locked engine asset set', () => {
  it('materializes and reopens only authenticated SHA-addressed engine inputs', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const set = await materializeLockedEngineAssets({
      target: 'darwin-arm64', ...value, outputRoot,
    })

    await expect(set.resolveEngineAsset(value.asset)).resolves.toBe(join(outputRoot, 'Assets', value.asset.sha256))
    await expect(set.resolveEngineLicense(value.license)).resolves.toBe(join(outputRoot, 'Licenses', value.license.sha256))
    await expect(openLockedEngineAssets({
      root: outputRoot, target: 'darwin-arm64', sourceLock: value.sourceLock, closureLock: value.closureLock,
    })).resolves.toMatchObject({ target: 'darwin-arm64', root: outputRoot })
  })

  it('rejects substituted, symbolic, hard-linked, and undeclared inputs and cleans failed output', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const wrong = structuredClone(value.closureLock)
    wrong.families.document.engineAssets[0].sha256 = '0'.repeat(64)
    await expect(materializeLockedEngineAssets({
      target: 'darwin-arm64', sourceLock: value.sourceLock, closureLock: wrong,
      blobs: value.blobs, outputRoot,
    })).rejects.toThrow('Locked engine asset set is invalid.')
    expect(() => realpathSync(outputRoot)).toThrow()

    const set = await materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot })
    const assetPath = await set.resolveEngineAsset(value.asset)
    chmodSync(assetPath, 0o644)
    writeFileSync(assetPath, 'changed')
    await expect(set.resolveEngineAsset(value.asset)).rejects.toThrow('Locked engine asset set is invalid.')

    const replacement = join(root, 'replacement')
    writeFileSync(replacement, Buffer.from('locked dmg'))
    rmSync(assetPath)
    symlinkSync(replacement, assetPath)
    await expect(set.resolveEngineAsset(value.asset)).rejects.toThrow('Locked engine asset set is invalid.')
    rmSync(assetPath)
    linkSync(replacement, assetPath)
    await expect(set.resolveEngineAsset(value.asset)).rejects.toThrow('Locked engine asset set is invalid.')
  })
})
