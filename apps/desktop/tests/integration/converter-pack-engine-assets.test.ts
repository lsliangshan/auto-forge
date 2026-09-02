import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  materializeLockedEngineAssets, openLockedEngineAssets,
} from '../../scripts/converter-packs/locked-engine-assets.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'

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
    const claim = JSON.parse(readFileSync(`${outputRoot}.claim`, 'utf8'))
    expect(claim.leaseMs).toBe(30_000)
    expect(Object.keys(claim).sort()).toEqual(['createdAtMs', 'leaseMs', 'nonce', 'partialName', 'pid'])
    const expired = new Date(Date.now() - 60_000)
    utimesSync(`${outputRoot}.claim`, expired, expired)

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

  it.each(['predecessor-link', 'active-unlink', 'partial-cleanup'] as const)(
    'recovers the %s fencing snapshot left by SIGKILL',
    async (step) => {
      const root = temporaryRoot()
      const value = fixture(root)
      const outputRoot = join(root, `engine-assets-${step}`)
      const claimPath = `${outputRoot}.claim`
      const nonce = randomUUID()
      const partialName = `.${step === 'predecessor-link' ? 'engine-assets-predecessor-link' : `engine-assets-${step}`}.${nonce}.partial`
      const partialRoot = join(root, partialName)
      const claim = { createdAtMs: Date.now(), leaseMs: 30_000, nonce, partialName, pid: 2_147_483_647 }
      writeFileSync(claimPath, canonicalBytes(claim), { mode: 0o600 })
      mkdirSync(partialRoot)
      const predecessor = `${claimPath}.${nonce}.predecessor`
      const marker = join(root, `${step}.ready`)
      const moduleUrl = new URL('../../scripts/converter-packs/locked-engine-assets.mjs', import.meta.url).href
      const script = String.raw`
        import { writeFile } from 'node:fs/promises'
        const [moduleUrl, target, sourceJson, closureJson, blobsJson, outputRoot, wantedStep, marker] = process.argv.slice(1)
        const { materializeLockedEngineAssets } = await import(moduleUrl)
        await materializeLockedEngineAssets({
          target, sourceLock: JSON.parse(sourceJson), closureLock: JSON.parse(closureJson),
          blobs: new Map(JSON.parse(blobsJson)), outputRoot,
          afterFenceStepForTest: async ({ step }) => {
            if (step !== wantedStep) return
            await writeFile(marker, 'ready')
            await new Promise(() => { setInterval(() => {}, 1_000) })
          },
        })
      `
      const child = spawn(process.execPath, [
        '--input-type=module', '-e', script, moduleUrl, 'darwin-arm64', JSON.stringify(value.sourceLock),
        JSON.stringify(value.closureLock), JSON.stringify([...value.blobs.entries()]), outputRoot, step, marker,
      ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
      children.push(child)
      await waitUntil(() => existsSync(marker))
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      child.kill('SIGKILL')
      await closed

      await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot })).resolves.toBeDefined()
      expect(existsSync(claimPath)).toBe(false)
      expect(existsSync(predecessor)).toBe(false)
      expect(existsSync(partialRoot)).toBe(false)
    },
  )

  it('recovers an initializing predecessor whose inode became a canonical claim before active unlink', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const claimPath = `${outputRoot}.claim`
    writeFileSync(claimPath, '', { mode: 0o600 })
    const identity = statSync(claimPath)
    const predecessor = `${claimPath}.${identity.dev}-${identity.ino}.predecessor`
    linkSync(claimPath, predecessor)
    const nonce = randomUUID()
    const partialName = `.engine-assets.${nonce}.partial`
    mkdirSync(join(root, partialName))
    writeFileSync(claimPath, canonicalBytes({
      createdAtMs: Date.now(), leaseMs: 30_000, nonce, partialName, pid: 2_147_483_647,
    }))
    rmSync(claimPath)

    await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot })).resolves.toBeDefined()
    expect(existsSync(predecessor)).toBe(false)
    expect(existsSync(join(root, partialName))).toBe(false)
  })

  it('serializes two real recovery processes without deleting the live recovery owner inode', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const claimPath = `${outputRoot}.claim`
    const nonce = randomUUID()
    const partialName = `.engine-assets.${nonce}.partial`
    writeFileSync(claimPath, canonicalBytes({
      createdAtMs: Date.now(), leaseMs: 30_000, nonce, partialName, pid: 2_147_483_647,
    }), { mode: 0o600 })
    mkdirSync(join(root, partialName))
    const original = statSync(claimPath)
    const marker = join(root, 'recoverer-a-ready')
    const release = join(root, 'recoverer-a-release')
    const moduleUrl = new URL('../../scripts/converter-packs/locked-engine-assets.mjs', import.meta.url).href
    const args = [
      moduleUrl, 'darwin-arm64', JSON.stringify(value.sourceLock), JSON.stringify(value.closureLock),
      JSON.stringify([...value.blobs.entries()]), outputRoot,
    ]
    const firstScript = String.raw`
      import { access, writeFile } from 'node:fs/promises'
      const [moduleUrl, target, sourceJson, closureJson, blobsJson, outputRoot, marker, release] = process.argv.slice(1)
      const { materializeLockedEngineAssets } = await import(moduleUrl)
      await materializeLockedEngineAssets({
        target, sourceLock: JSON.parse(sourceJson), closureLock: JSON.parse(closureJson),
        blobs: new Map(JSON.parse(blobsJson)), outputRoot,
        afterFenceStepForTest: async ({ step }) => {
          if (step !== 'predecessor-link') return
          await writeFile(marker, 'ready')
          while (true) {
            try { await access(release); return } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
          }
        },
      })
    `
    const first = spawn(process.execPath, [
      '--input-type=module', '-e', firstScript, ...args, marker, release,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(first)
    await waitUntil(() => existsSync(marker))

    const secondScript = String.raw`
      const [moduleUrl, target, sourceJson, closureJson, blobsJson, outputRoot] = process.argv.slice(1)
      const { materializeLockedEngineAssets } = await import(moduleUrl)
      try {
        await materializeLockedEngineAssets({
          target, sourceLock: JSON.parse(sourceJson), closureLock: JSON.parse(closureJson),
          blobs: new Map(JSON.parse(blobsJson)), outputRoot,
        })
        process.exitCode = 2
      } catch (error) {
        process.stderr.write(String(error?.message ?? error))
      }
    `
    const second = spawn(process.execPath, [
      '--input-type=module', '-e', secondScript, ...args,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(second)
    let secondError = ''
    second.stderr?.on('data', (chunk) => { secondError += chunk.toString() })
    await new Promise<void>((resolve) => second.once('close', () => resolve()))

    expect(second.exitCode).toBe(0)
    expect(secondError).toContain('Private directory publication is already claimed.')
    const preserved = statSync(claimPath)
    expect({ dev: preserved.dev, ino: preserved.ino }).toEqual({ dev: original.dev, ino: original.ino })
    expect(first.exitCode).toBeNull()

    const closed = new Promise<void>((resolve) => first.once('close', () => resolve()))
    writeFileSync(release, 'continue')
    await closed
    expect(first.exitCode).toBe(0)
    await expect(openLockedEngineAssets({
      root: outputRoot, target: 'darwin-arm64', sourceLock: value.sourceLock, closureLock: value.closureLock,
    })).resolves.toBeDefined()
  })

  it('fails closed when a fencing predecessor has extra links', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const claimPath = `${outputRoot}.claim`
    const nonce = randomUUID()
    const partialName = `.engine-assets.${nonce}.partial`
    writeFileSync(claimPath, canonicalBytes({
      createdAtMs: Date.now(), leaseMs: 30_000, nonce, partialName, pid: 2_147_483_647,
    }), { mode: 0o600 })
    mkdirSync(join(root, partialName))
    linkSync(claimPath, `${claimPath}.${nonce}.predecessor`)
    linkSync(claimPath, `${claimPath}.unexpected-link`)

    await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot }))
      .rejects.toThrow('Private directory publication claim is invalid.')
    expect(existsSync(outputRoot)).toBe(false)
  })

  it('cleans an old predecessor without unlinking a newer live owner claim', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    const claimPath = `${outputRoot}.claim`
    const oldNonce = randomUUID()
    const oldPartialName = `.engine-assets.${oldNonce}.partial`
    const oldClaim = canonicalBytes({
      createdAtMs: Date.now(), leaseMs: 30_000, nonce: oldNonce,
      partialName: oldPartialName, pid: 2_147_483_647,
    })
    writeFileSync(claimPath, oldClaim, { mode: 0o600 })
    mkdirSync(join(root, oldPartialName))
    const predecessor = `${claimPath}.${oldNonce}.predecessor`
    linkSync(claimPath, predecessor)
    rmSync(claimPath)
    const newNonce = randomUUID()
    const newClaim = canonicalBytes({
      createdAtMs: Date.now(), leaseMs: 30_000, nonce: newNonce,
      partialName: `.engine-assets.${newNonce}.partial`, pid: process.pid,
    })
    writeFileSync(claimPath, newClaim, { mode: 0o600 })

    await expect(materializeLockedEngineAssets({ target: 'darwin-arm64', ...value, outputRoot }))
      .rejects.toThrow('Private directory publication is already claimed.')
    expect(readFileSync(claimPath)).toEqual(newClaim)
    expect(existsSync(predecessor)).toBe(false)
    expect(existsSync(join(root, oldPartialName))).toBe(false)
  })

  it('prevents a replaced initializer from entering private population', async () => {
    const root = temporaryRoot()
    const value = fixture(root)
    const outputRoot = join(root, 'engine-assets')
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let readyFirst!: () => void
    let readySecond!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const firstReady = new Promise<void>((resolve) => { readyFirst = resolve })
    const secondReady = new Promise<void>((resolve) => { readySecond = resolve })
    let firstReachedPopulation = false
    const firstBlobs = new Map([...value.blobs].map(([digest, blob]) => [digest, {
      ...blob,
      get path() { firstReachedPopulation = true; return blob.path },
    }]))
    const first = materializeLockedEngineAssets({
      target: 'darwin-arm64', ...value, blobs: firstBlobs, outputRoot,
      afterClaimOpenForTest: async () => { readyFirst(); await firstGate },
    })
    await firstReady
    await new Promise((resolve) => setTimeout(resolve, 300))
    const second = materializeLockedEngineAssets({
      target: 'darwin-arm64', ...value, outputRoot,
      afterClaimOpenForTest: async () => { readySecond(); await secondGate },
    })
    await secondReady
    releaseFirst()

    await expect(first).rejects.toThrow('Private directory publication claim was lost.')
    expect(firstReachedPopulation).toBe(false)
    releaseSecond()
    await expect(second).resolves.toBeDefined()
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
