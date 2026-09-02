import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  materializeLockedEngineAssets, openLockedEngineAssets,
} from '../../scripts/converter-packs/locked-engine-assets.mjs'

const roots: string[] = []
const children: ChildProcess[] = []
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
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

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for child')
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
    expect(JSON.parse(readFileSync(join(outputRoot, 'manifest.json'), 'utf8'))
      .records.map((record: { mode: number }) => record.mode)).toEqual([0o444, 0o444])
    await expect(openLockedEngineAssets({
      root: outputRoot, target: 'darwin-arm64', sourceLock: value.sourceLock, closureLock: value.closureLock,
    })).resolves.toMatchObject({ target: 'darwin-arm64', root: outputRoot })
    chmodSync(join(outputRoot, 'manifest.json'), 0o666)
    await expect(openLockedEngineAssets({
      root: outputRoot, target: 'darwin-arm64', sourceLock: value.sourceLock, closureLock: value.closureLock,
    })).rejects.toThrow('Locked engine asset set is invalid.')
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
    chmodSync(assetPath, 0o666)
    await expect(set.resolveEngineAsset(value.asset)).rejects.toThrow('Locked engine asset set is invalid.')
    chmodSync(assetPath, 0o777)
    await expect(set.resolveEngineAsset(value.asset)).rejects.toThrow('Locked engine asset set is invalid.')
    chmodSync(assetPath, 0o444)
    await expect(set.resolveEngineAsset({ ...value.asset, destination: 'share/undeclared.dmg' }))
      .rejects.toThrow('Locked engine asset set is invalid.')
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

  it('keeps a live owner claim and recovers its private sibling after SIGKILL', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const marker = join(root, 'ready')
    const moduleUrl = new URL('../../scripts/converter-packs/locked-engine-assets.mjs', import.meta.url).href
    const blobRecords = [...value.blobs.entries()]
    const script = String.raw`
      import { writeFile } from 'node:fs/promises'
      const [moduleUrl, target, sourceJson, closureJson, blobsJson, outputRoot, marker] = process.argv.slice(1)
      const { materializeLockedEngineAssets } = await import(moduleUrl)
      const blobs = new Map(JSON.parse(blobsJson))
      await materializeLockedEngineAssets({
        target, sourceLock: JSON.parse(sourceJson), closureLock: JSON.parse(closureJson), blobs, outputRoot,
        beforePublishForTest: async () => {
          await writeFile(marker, 'ready')
          await new Promise(() => { setInterval(() => {}, 1_000) })
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, 'darwin-arm64', JSON.stringify(value.sourceLock),
      JSON.stringify(value.closureLock), JSON.stringify(blobRecords), outputRoot, marker,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    await waitUntil(() => existsSync(marker))

    await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot }))
      .rejects.toThrow('Private directory publication is already claimed.')
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed

    await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot })).resolves.toBeDefined()
    expect(existsSync(`${outputRoot}.claim`)).toBe(false)
    expect(readdirSync(root).filter((name) => name.includes('.engine-assets.') && name.endsWith('.partial'))).toEqual([])
  })

  it('fails closed on an initializing claim and recovers it after SIGKILL and grace', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const marker = join(root, 'initializing')
    const moduleUrl = new URL('../../scripts/converter-packs/locked-engine-assets.mjs', import.meta.url).href
    const script = String.raw`
      import { writeFile } from 'node:fs/promises'
      const [moduleUrl, target, sourceJson, closureJson, blobsJson, outputRoot, marker] = process.argv.slice(1)
      const { materializeLockedEngineAssets } = await import(moduleUrl)
      await materializeLockedEngineAssets({
        target, sourceLock: JSON.parse(sourceJson), closureLock: JSON.parse(closureJson),
        blobs: new Map(JSON.parse(blobsJson)), outputRoot,
        afterClaimOpenForTest: async () => {
          await writeFile(marker, 'ready')
          await new Promise(() => { setInterval(() => {}, 1_000) })
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, 'darwin-arm64', JSON.stringify(value.sourceLock),
      JSON.stringify(value.closureLock), JSON.stringify([...value.blobs.entries()]), outputRoot, marker,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    await waitUntil(() => existsSync(marker))
    expect(readFileSync(`${outputRoot}.claim`).byteLength).toBe(0)

    await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot }))
      .rejects.toThrow('Private directory publication is already claimed.')
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed
    await new Promise((resolve) => setTimeout(resolve, 300))

    await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot })).resolves.toBeDefined()
    expect(existsSync(`${outputRoot}.claim`)).toBe(false)
  })

  it('does not clobber a destination appearing in the publish window', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')

    await expect(materializeLockedEngineAssets({
      target: 'darwin-arm64', ...value, outputRoot,
      beforePublishForTest: () => { mkdirSync(outputRoot) },
    })).rejects.toThrow('Private directory publication destination already exists.')

    expect(readdirSync(outputRoot)).toEqual([])
    expect(existsSync(`${outputRoot}.claim`)).toBe(false)
  })

  it('attempts every claim and private-root cleanup while preserving the primary failure first', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const attempts: string[] = []

    const initializationFailure = await materializeLockedEngineAssets({
      target: 'darwin-arm64', ...value, outputRoot,
      afterClaimOpenForTest: () => { throw new Error('claim primary') },
      claimInitializationCleanupForTest: async ({ step, run }: { step: string; run: () => Promise<unknown> }) => {
        attempts.push(step)
        if (step === 'close') {
          await run()
          throw new Error('close cleanup')
        }
        if (step === 'unlink') {
          const error = new Error('unlink EACCES') as Error & { code: string }
          error.code = 'EACCES'
          throw error
        }
        await run()
      },
    }).then(() => undefined, (error: unknown) => error as AggregateError)
    expect(attempts).toEqual(['close', 'unlink', 'sync'])
    expect(initializationFailure.errors.map((error) => (error as Error).message))
      .toEqual(['claim primary', 'close cleanup', 'unlink EACCES'])
    rmSync(`${outputRoot}.claim`, { force: true })

    const cleanupFailure = await materializeLockedEngineAssets({
      target: 'darwin-arm64', ...value, outputRoot,
      beforePublishForTest: () => { throw new Error('materialize primary') },
      removePrivateRootForTest: async () => {
        const error = new Error('rm EACCES') as Error & { code: string }
        error.code = 'EACCES'
        throw error
      },
    }).then(() => undefined, (error: unknown) => error as AggregateError)
    expect(cleanupFailure.errors.map((error) => (error as Error).message))
      .toEqual(['materialize primary', 'rm EACCES'])
    expect(existsSync(`${outputRoot}.claim`)).toBe(false)
  })
})
