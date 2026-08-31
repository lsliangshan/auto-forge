import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import { loadConverterSourceLock } from '../../scripts/converter-packs/source-lock.mjs'

const temporaryRoots: string[] = []
const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-source-lock-')))
  temporaryRoots.push(root)
  return root
}

function fixture() {
  function engine(name: string, version: string, license: string, sourceUrl: string, character: string, kind = 'homebrew-bottle') {
    const digest = character.repeat(64)
    const cellar = kind === 'homebrew-bottle'
    return {
      name,
      version,
      license,
      source: { url: sourceUrl, sha256: digest },
      acquisitions: {
        'darwin-arm64': {
          kind,
          url: `https://downloads.example.test/${name}-arm64.archive`,
          sha256: digest,
          cellar: cellar ? '/opt/homebrew/Cellar' : null,
        },
        'darwin-x64': {
          kind,
          url: `https://downloads.example.test/${name}-x64.archive`,
          sha256: digest,
          cellar: cellar ? '/usr/local/Cellar' : null,
        },
      },
    }
  }
  return {
    schemaVersion: 1,
    homebrewCoreRevision: '1'.repeat(40),
    homebrewCaskRevision: '2'.repeat(40),
    targets: ['darwin-arm64', 'darwin-x64'],
    engines: [
      engine('ffmpeg', '9.0.1+1', 'GPL-3.0-or-later', 'https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz', 'a'),
      engine('libreoffice', '26.8.0', 'MPL-2.0', 'https://download.documentfoundation.org/libreoffice/src/26.8.0/libreoffice-26.8.0.3.tar.xz', 'b', 'dmg'),
      engine('libvips', '8.18.6', 'LGPL-2.1-or-later', 'https://github.com/libvips/libvips/releases/download/v8.18.6/vips-8.18.6.tar.xz', 'c'),
      engine('poppler', '26.8.0', 'GPL-2.0-only OR GPL-3.0-only', 'https://poppler.freedesktop.org/poppler-26.08.0.tar.xz', 'd'),
    ],
  }
}

function writeLock(root: string, value: unknown): string {
  const directory = join(root, 'input')
  mkdirSync(directory)
  const path = join(directory, 'sources.lock.json')
  writeFileSync(path, canonicalBytes(value))
  return path
}

describe('converter pack source lock', () => {
  it('returns the exact acquisition selected for one supported target', async () => {
    const root = temporaryRoot()
    const path = writeLock(root, fixture())

    const selected = await loadConverterSourceLock({ path, target: 'darwin-arm64' })

    expect(selected.target).toBe('darwin-arm64')
    expect(selected.homebrewCoreRevision).toBe('1111111111111111111111111111111111111111')
    expect(selected.homebrewCaskRevision).toBe('2222222222222222222222222222222222222222')
    expect(selected.engines.map(({ name }) => name)).toEqual(['ffmpeg', 'libreoffice', 'libvips', 'poppler'])
    expect(selected.engines[0]).toEqual({
        name: 'ffmpeg',
        version: '9.0.1+1',
        license: 'GPL-3.0-or-later',
        source: {
          url: 'https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        acquisition: {
          kind: 'homebrew-bottle',
          url: 'https://downloads.example.test/ffmpeg-arm64.archive',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          cellar: '/opt/homebrew/Cellar',
        },
    })
    expect(selected.engines[1]?.acquisition).toEqual({
      kind: 'dmg',
      url: 'https://downloads.example.test/libreoffice-arm64.archive',
      sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      cellar: null,
    })
  })

  it('rejects unknown fields instead of silently ignoring a misspelled security field', async () => {
    const root = temporaryRoot()
    const value = { ...fixture(), homebrewCoreRevison: '3'.repeat(40) }
    const path = writeLock(root, value)

    await expect(loadConverterSourceLock({ path, target: 'darwin-arm64' }))
      .rejects.toThrow('Source lock has an invalid schema.')
  })

  it('rejects semantically equal JSON whose bytes are not canonical', async () => {
    const root = temporaryRoot()
    const path = writeLock(root, fixture())
    writeFileSync(path, `${JSON.stringify(fixture(), null, 2)}\n`)

    await expect(loadConverterSourceLock({ path, target: 'darwin-arm64' }))
      .rejects.toThrow('Source lock is not canonical JSON.')
  })

  it('rejects a caller target outside the first production matrix', async () => {
    const root = temporaryRoot()
    const path = writeLock(root, fixture())

    await expect(loadConverterSourceLock({ path, target: 'linux-x64' }))
      .rejects.toThrow('Source lock target is unsupported.')
  })

  it('selects both architectures from the checked-in production lock', async () => {
    const path = join(desktopRoot, 'converter-packs', 'sources.lock.json')

    const arm64 = await loadConverterSourceLock({ path, target: 'darwin-arm64' })
    const x64 = await loadConverterSourceLock({ path, target: 'darwin-x64' })

    expect(arm64.engines.map(({ name, version }) => `${name}@${version}`)).toEqual([
      'ffmpeg@9.0.1+1',
      'libreoffice@26.8.0',
      'libvips@8.18.6',
      'poppler@26.8.0',
    ])
    expect(arm64.engines.map(({ acquisition }) => acquisition.cellar)).toEqual([
      '/opt/homebrew/Cellar', null, '/opt/homebrew/Cellar', '/opt/homebrew/Cellar',
    ])
    expect(x64.engines.map(({ acquisition }) => acquisition.cellar)).toEqual([
      '/usr/local/Cellar', null, '/usr/local/Cellar', '/usr/local/Cellar',
    ])
    expect(arm64.engines[1]?.source.sha256).toBe('42116e256933aa575974e420ffa04f7cd7096f4b7ca5d0907ddeaf2a07f68f94')
    expect(x64.engines[1]?.acquisition.sha256).toBe('2dcbce4894e01bc1ecd594658e2cbda70ff7bfcd0b310f35d38887797172d09e')
  })

  it.each([
    ['wrong schema version', (value: ReturnType<typeof fixture>) => { value.schemaVersion = 2 }],
    ['invalid core revision', (value: ReturnType<typeof fixture>) => { value.homebrewCoreRevision = 'not-a-commit' }],
    ['reversed targets', (value: ReturnType<typeof fixture>) => { value.targets.reverse() }],
    ['missing engine', (value: ReturnType<typeof fixture>) => { value.engines.pop() }],
    ['duplicate engine', (value: ReturnType<typeof fixture>) => { value.engines[3] = structuredClone(value.engines[2]!) }],
    ['HTTP source', (value: ReturnType<typeof fixture>) => { value.engines[0]!.source.url = 'http://ffmpeg.example.test/source.tar.xz' }],
    ['invalid source digest', (value: ReturnType<typeof fixture>) => { value.engines[0]!.source.sha256 = 'abc' }],
    ['missing target acquisition', (value: ReturnType<typeof fixture>) => { delete (value.engines[0]!.acquisitions as Record<string, unknown>)['darwin-x64'] }],
    ['unknown nested key', (value: ReturnType<typeof fixture>) => { Object.assign(value.engines[0]!.source, { sha265: 'e'.repeat(64) }) }],
    ['invalid acquisition kind', (value: ReturnType<typeof fixture>) => { value.engines[0]!.acquisitions['darwin-arm64'].kind = 'zip' }],
    ['bottle without cellar', (value: ReturnType<typeof fixture>) => { value.engines[0]!.acquisitions['darwin-arm64'].cellar = null }],
    ['DMG with cellar', (value: ReturnType<typeof fixture>) => { value.engines[1]!.acquisitions['darwin-arm64'].cellar = '/opt/homebrew/Cellar' }],
  ])('rejects %s', async (_label, mutate) => {
    const root = temporaryRoot()
    const value = fixture()
    mutate(value)
    const path = writeLock(root, value)

    await expect(loadConverterSourceLock({ path, target: 'darwin-arm64' }))
      .rejects.toThrow('Source lock has an invalid schema.')
  })
})
