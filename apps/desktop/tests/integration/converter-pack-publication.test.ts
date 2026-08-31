import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildConverterPackIndex } from '../../scripts/converter-packs/build-index.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import {
  createCoscliObjectStore,
  createFilesystemObjectStore,
  publishConverterPackRelease,
} from '../../scripts/converter-packs/publish-release.mjs'
import { signConverterPackIndex } from '../../scripts/converter-packs/sign-index.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-publication-')))
  temporaryRoots.push(root)
  return root
}

async function releaseFixture(root: string, sequence: number, publicBaseUrl: string) {
  const stage = join(root, `stage-${sequence}`)
  const pack = join(stage, 'packs', 'media-darwin-arm64')
  const payload = join(pack, 'payload')
  mkdirSync(join(payload, 'bin'), { recursive: true })
  mkdirSync(join(payload, 'LICENSES'), { recursive: true })
  writeFileSync(join(payload, 'bin', 'ffmpeg'), `ffmpeg-${sequence}\n`)
  chmodSync(join(payload, 'bin', 'ffmpeg'), 0o755)
  writeFileSync(join(payload, 'LICENSES', 'ffmpeg.txt'), 'FFmpeg license\n')
  writeFileSync(join(stage, 'release.json'), canonicalBytes({
    schemaVersion: 1, generatedAt: `2026-08-${String(10 + sequence).padStart(2, '0')}T00:00:00.000Z`, sequence,
  }))
  writeFileSync(join(pack, 'pack.json'), canonicalBytes({
    schemaVersion: 1,
    name: 'media', version: '1.2.3', platform: 'darwin', arch: 'arm64',
    archiveUrl: `${publicBaseUrl}/releases/${sequence}/media-1.2.3-darwin-arm64.tar`,
    files: [
      { path: 'bin/ffmpeg', role: 'executable' },
      { path: 'LICENSES/ffmpeg.txt', role: 'license' },
    ],
  }))
  const release = join(root, `release-${sequence}`)
  await buildConverterPackIndex({ input: stage, output: release, mode: 'test' })
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPath = join(root, `private-${sequence}.pem`)
  const publicKeyPath = join(root, `public-${sequence}.pem`)
  writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
  await signConverterPackIndex({ indexPath: join(release, 'index.json'), privateKeyPath, mode: 'test' })
  return { release, publicKeyPath }
}

describe('converter pack immutable publication', () => {
  it('uses one absolute COSCLI binary, an external config, and create-only immutable uploads', async () => {
    const root = temporaryRoot()
    const coscli = join(root, 'coscli')
    const config = join(root, 'cos.yaml')
    const scratch = join(root, 'scratch')
    writeFileSync(coscli, 'fixture')
    chmodSync(coscli, 0o755)
    writeFileSync(config, 'PRIVATE-SENTINEL-CONFIG')
    chmodSync(config, 0o600)
    mkdirSync(scratch)
    const remote = new Map<string, Buffer>()
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    const run = async (executable: string, args: readonly string[]) => {
      calls.push({ executable, args })
      const [command, source, destination] = args
      if (command !== 'cp') return { status: 1, stdout: '', stderr: 'unexpected' }
      const sourceRemote = source!.startsWith('cos://')
      const destinationRemote = destination!.startsWith('cos://')
      if (!sourceRemote && destinationRemote) {
        if (args.includes('--forbid-overwrite') && remote.has(destination!)) return { status: 1, stdout: '', stderr: 'exists' }
        remote.set(destination!, readFileSync(source!))
      } else if (sourceRemote && !destinationRemote) {
        writeFileSync(destination!, remote.get(source!)!)
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const store = createCoscliObjectStore({
      coscliPath: coscli,
      configPath: config,
      bucket: 'release-bucket-1250000000',
      scratchRoot: scratch,
      run,
    })

    await store.putImmutable('releases/1/archive.tar', Buffer.from('archive'))
    await expect(store.read('releases/1/archive.tar')).resolves.toEqual(Buffer.from('archive'))
    await store.promoteStable({ generation: 1, indexBytes: Buffer.from('index'), signatureBytes: Buffer.from('signature') })
    await expect(store.read('stable/index.json')).resolves.toEqual(Buffer.from('index'))
    expect(calls.every((call) => call.executable === coscli)).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('PRIVATE-SENTINEL-CONFIG')
    expect(calls.find((call) => call.args.includes('cos://release-bucket-1250000000/releases/1/archive.tar'))?.args).toContain('--forbid-overwrite')
  })

  it('uploads immutable objects, verifies read-back, then promotes the stable signed pair', async () => {
    const root = temporaryRoot()
    const publicBaseUrl = 'https://cdn.example.test/converter-packs'
    const fixture = await releaseFixture(root, 1, publicBaseUrl)
    const objectRoot = join(root, 'objects')
    mkdirSync(objectRoot)
    const store = createFilesystemObjectStore({ root: objectRoot })

    await publishConverterPackRelease({
      releaseRoot: fixture.release,
      publicKeyPath: fixture.publicKeyPath,
      publicBaseUrl,
      sequence: 1,
      mode: 'test',
      store,
    })

    const index = JSON.parse(readFileSync(join(fixture.release, 'index.json'), 'utf8')) as { packs: Array<{ archiveUrl: string }> }
    const archiveName = index.packs[0]!.archiveUrl.split('/').at(-1)!
    expect(readFileSync(join(objectRoot, 'releases', '1', archiveName))).toEqual(readFileSync(join(fixture.release, archiveName)))
    expect(readFileSync(join(objectRoot, 'stable', 'index.json'))).toEqual(readFileSync(join(fixture.release, 'index.json')))
    expect(readFileSync(join(objectRoot, 'stable', 'index.sig'))).toEqual(readFileSync(join(fixture.release, 'index.sig')))
  })

  it('keeps the previous stable pair unchanged across read-back and promotion failures', async () => {
    const root = temporaryRoot()
    const publicBaseUrl = 'https://cdn.example.test/converter-packs'
    const first = await releaseFixture(root, 1, publicBaseUrl)
    const second = await releaseFixture(root, 2, publicBaseUrl)
    const objectRoot = join(root, 'objects')
    mkdirSync(objectRoot)
    await publishConverterPackRelease({
      releaseRoot: first.release, publicKeyPath: first.publicKeyPath, publicBaseUrl,
      sequence: 1, mode: 'test', store: createFilesystemObjectStore({ root: objectRoot }),
    })
    const oldIndex = readFileSync(join(objectRoot, 'stable', 'index.json'))
    const oldSignature = readFileSync(join(objectRoot, 'stable', 'index.sig'))

    await expect(publishConverterPackRelease({
      releaseRoot: second.release, publicKeyPath: second.publicKeyPath, publicBaseUrl,
      sequence: 2, mode: 'test',
      store: createFilesystemObjectStore({
        root: objectRoot,
        beforePromote: async () => { throw new Error('injected promotion failure') },
      }),
    })).rejects.toThrow('injected promotion failure')
    expect(readFileSync(join(objectRoot, 'stable', 'index.json'))).toEqual(oldIndex)
    expect(readFileSync(join(objectRoot, 'stable', 'index.sig'))).toEqual(oldSignature)

    const corruptRoot = join(root, 'corrupt-objects')
    mkdirSync(corruptRoot)
    const corruptStore = createFilesystemObjectStore({
      root: corruptRoot,
      afterRead: async (key: string, bytes: Buffer) => key.endsWith('.tar') ? Buffer.from('corrupt') : bytes,
    })
    await expect(publishConverterPackRelease({
      releaseRoot: second.release, publicKeyPath: second.publicKeyPath, publicBaseUrl,
      sequence: 2, mode: 'test', store: corruptStore,
    })).rejects.toThrow(/read-back/iu)
    expect(() => readFileSync(join(root, 'corrupt-objects', 'stable', 'index.json'))).toThrow()

    await publishConverterPackRelease({
      releaseRoot: second.release, publicKeyPath: second.publicKeyPath, publicBaseUrl,
      sequence: 2, mode: 'test', store: createFilesystemObjectStore({ root: objectRoot }),
    })
    expect(readFileSync(join(objectRoot, 'stable', 'index.json'))).toEqual(readFileSync(join(second.release, 'index.json')))
  })

  it('rejects unknown release files and insecure public URLs before object-store writes', async () => {
    const root = temporaryRoot()
    const publicBaseUrl = 'https://cdn.example.test/converter-packs'
    const fixture = await releaseFixture(root, 1, publicBaseUrl)
    const objectRoot = join(root, 'objects')
    mkdirSync(objectRoot)
    writeFileSync(join(fixture.release, 'private.pem'), '-----BEGIN PRIVATE KEY-----\n')

    await expect(publishConverterPackRelease({
      releaseRoot: fixture.release, publicKeyPath: fixture.publicKeyPath, publicBaseUrl,
      sequence: 1, mode: 'test', store: createFilesystemObjectStore({ root: objectRoot }),
    })).rejects.toThrow(/unknown|private|unexpected/iu)
    await expect(publishConverterPackRelease({
      releaseRoot: fixture.release, publicKeyPath: fixture.publicKeyPath,
      publicBaseUrl: 'http://cdn.example.test/converter-packs',
      sequence: 1, mode: 'test', store: createFilesystemObjectStore({ root: objectRoot }),
    })).rejects.toThrow(/https/iu)
    expect(readdirSync(objectRoot)).toEqual([])
  })

  it('rejects the development root key before calling the production object store', async () => {
    const root = temporaryRoot()
    const fixture = await releaseFixture(root, 1, 'https://cdn.example.test/converter-packs')
    const developmentPublicKeyPath = join(
      root,
      'development-public.pem',
    )
    writeFileSync(
      developmentPublicKeyPath,
      readFileSync(join(
        process.cwd(),
        'electron/main/conversion/fixtures/test-converter-root-public-key.pem',
      )),
    )
    const calls: string[] = []
    const store = {
      putImmutable: async () => { calls.push('putImmutable') },
      read: async () => { calls.push('read'); return Buffer.alloc(0) },
      promoteStable: async () => { calls.push('promoteStable') },
    }

    await expect(publishConverterPackRelease({
      releaseRoot: fixture.release,
      publicKeyPath: developmentPublicKeyPath,
      publicBaseUrl: 'https://cdn.example.test/converter-packs',
      sequence: 1,
      mode: 'production',
      store,
    })).rejects.toThrow(/development|test/iu)
    expect(calls).toEqual([])
  })
})
