import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createProductionBootstrap } from '../../scripts/converter-packs/create-production-bootstrap.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const pinnedRoot = join(desktopRoot, 'resources', 'converter-packs')
const productionBuilder = join(desktopRoot, 'electron-builder.production.cjs')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-bootstrap-')))
  temporaryRoots.push(root)
  return root
}

describe('production converter bootstrap', () => {
  it('writes only canonical enabled metadata and an Ed25519 public key', async () => {
    const root = temporaryRoot()
    const output = join(root, 'metadata')
    const publicKeyPath = join(root, 'public.pem')
    const pair = generateKeyPairSync('ed25519')
    writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }))

    await createProductionBootstrap({
      indexUrl: 'https://cdn.example.test/converter-packs/stable/index.json',
      publicKeyPath,
      output,
    })

    expect(readdirSync(output).sort()).toEqual(['bootstrap.json', 'index.schema.json', 'root-public-key.pem'])
    expect(JSON.parse(readFileSync(join(output, 'bootstrap.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      downloadsEnabled: true,
      indexUrl: 'https://cdn.example.test/converter-packs/stable/index.json',
      rootPublicKeyFile: 'root-public-key.pem',
      requiredPackFamilies: ['image-icon', 'document', 'pdf', 'media'],
      supportedTargets: ['darwin-arm64', 'darwin-x64'],
    })
    expect(readFileSync(join(output, 'index.schema.json'))).toEqual(readFileSync(join(pinnedRoot, 'index.schema.json')))
    expect(readFileSync(join(output, 'root-public-key.pem'), 'utf8')).toBe(pair.publicKey.export({ type: 'spki', format: 'pem' }))
  })

  it('rejects insecure URLs, private or non-Ed25519 keys, and protected output paths', async () => {
    const root = temporaryRoot()
    const ed25519 = generateKeyPairSync('ed25519')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicKeyPath = join(root, 'public.pem')
    const privateKeyPath = join(root, 'private.pem')
    const rsaPath = join(root, 'rsa.pem')
    writeFileSync(publicKeyPath, ed25519.publicKey.export({ type: 'spki', format: 'pem' }))
    writeFileSync(privateKeyPath, ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    writeFileSync(rsaPath, rsa.publicKey.export({ type: 'spki', format: 'pem' }))
    const validUrl = 'https://cdn.example.test/converter-packs/stable/index.json'

    await expect(createProductionBootstrap({ indexUrl: validUrl.replace('https:', 'http:'), publicKeyPath, output: join(root, 'http') })).rejects.toThrow(/https/iu)
    await expect(createProductionBootstrap({ indexUrl: validUrl, publicKeyPath: privateKeyPath, output: join(root, 'private') })).rejects.toThrow(/public|private/iu)
    await expect(createProductionBootstrap({ indexUrl: validUrl, publicKeyPath: rsaPath, output: join(root, 'rsa') })).rejects.toThrow(/ed25519/iu)
    await expect(createProductionBootstrap({
      indexUrl: validUrl,
      publicKeyPath: join(desktopRoot, 'electron/main/conversion/fixtures/test-converter-root-public-key.pem'),
      output: join(root, 'development-key'),
    })).rejects.toThrow(/development|test|production/iu)
    await expect(createProductionBootstrap({ indexUrl: validUrl, publicKeyPath, output: pinnedRoot })).rejects.toThrow(/checked-in|resource/iu)

    const target = join(root, 'target')
    const linked = join(root, 'linked')
    mkdirSync(target)
    symlinkSync(target, linked)
    await expect(createProductionBootstrap({ indexUrl: validUrl, publicKeyPath, output: linked })).rejects.toThrow()
  })

  it('keeps ordinary and production Electron builder metadata roots separate', () => {
    const ordinary = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8')
    const production = readFileSync(productionBuilder, 'utf8')
    expect(ordinary).toContain('from: resources/converter-packs')
    expect(production).toContain('AUTOFORGE_CONVERTER_METADATA_ROOT')
    expect(production).not.toContain('from: resources/converter-packs')
    expect(production).toContain('root-public-key.pem')
    expect(production).toContain('bootstrap.json')
    expect(production).toContain('index.schema.json')
  })
})
