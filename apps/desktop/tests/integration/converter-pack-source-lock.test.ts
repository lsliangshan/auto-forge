import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import { loadConverterSourceLock, loadConverterSourceLockMain } from '../../scripts/converter-packs/source-lock.mjs'

const temporaryRoots: string[] = []
const targets = ['darwin-arm64', 'darwin-x64'] as const

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-source-lock-')))
  temporaryRoots.push(root)
  return root
}

function bottle(name: string, target: typeof targets[number], character: string, bytes: number) {
  return {
    kind: 'homebrew-bottle',
    url: `https://downloads.example.test/${name}-${target}.tar.gz`,
    sha256: character.repeat(64),
    bytes,
    cellar: target === 'darwin-arm64' ? '/opt/homebrew/Cellar' : '/usr/local/Cellar',
  }
}

function formula(name: string, version: string, character: string, bytes: number) {
  return {
    name,
    version,
    revision: 0,
    license: 'MIT',
    acquisitions: {
      'darwin-arm64': bottle(name, 'darwin-arm64', character, bytes),
      'darwin-x64': bottle(name, 'darwin-x64', character, bytes + 1),
    },
    licenses: targets.map((target) => ({
      kind: 'bottle-entry',
      target,
      path: 'LICENSE',
      sha256: character.repeat(64),
      bytes: 12,
      destination: `licenses/${name}.LICENSE`,
    })),
  }
}

function fixture() {
  const formulae = [
    formula('ffmpeg', '9.0.1+1', 'a', 100),
    formula('glib', '2.86.0', 'e', 110),
    formula('poppler', '26.8.0', 'd', 130),
    formula('vips', '8.18.6', 'c', 120),
  ]
  const root = (name: string) => formulae.find((entry) => entry.name === name)!
  return {
    schemaVersion: 2,
    homebrewCoreRevision: '1'.repeat(40),
    homebrewCaskRevision: '2'.repeat(40),
    targets: [...targets],
    engines: [
      {
        name: 'ffmpeg', version: '9.0.1+1', license: 'GPL-3.0-or-later', rootFormula: 'ffmpeg',
        acquisitions: structuredClone(root('ffmpeg').acquisitions),
        licenses: [],
      },
      {
        name: 'libreoffice', version: '26.8.0', license: 'MPL-2.0', rootFormula: null,
        acquisitions: {
          'darwin-arm64': {
            kind: 'dmg', url: 'https://downloads.example.test/libreoffice-darwin-arm64.dmg',
            sha256: 'b'.repeat(64), bytes: 140, cellar: null,
          },
          'darwin-x64': {
            kind: 'dmg', url: 'https://downloads.example.test/libreoffice-darwin-x64.dmg',
            sha256: 'f'.repeat(64), bytes: 141, cellar: null,
          },
        },
        licenses: [{
          kind: 'download', url: 'https://downloads.example.test/libreoffice-LICENSE',
          sha256: '9'.repeat(64), bytes: 15, destination: 'licenses/libreoffice.LICENSE',
        }],
      },
      {
        name: 'libvips', version: '8.18.6', license: 'LGPL-2.1-or-later', rootFormula: 'vips',
        acquisitions: structuredClone(root('vips').acquisitions),
        licenses: [],
      },
      {
        name: 'poppler', version: '26.8.0', license: 'GPL-2.0-only OR GPL-3.0-only', rootFormula: 'poppler',
        acquisitions: structuredClone(root('poppler').acquisitions),
        licenses: [],
      },
    ],
    formulae,
    provenance: {
      repositoryRevision: '3'.repeat(40),
      captures: Object.fromEntries(targets.map((target) => [target, { captureSha256: '4'.repeat(64), probesSha256: '5'.repeat(64) }])),
    },
    closureLocks: {
      'darwin-arm64': { path: 'closures/darwin-arm64.lock.json', sha256: '6'.repeat(64), bytes: 600 },
      'darwin-x64': { path: 'closures/darwin-x64.lock.json', sha256: '7'.repeat(64), bytes: 700 },
    },
  }
}

function writeLock(root: string, value: unknown): string {
  const path = join(root, 'sources.lock.json')
  writeFileSync(path, canonicalBytes(value))
  return path
}

describe('converter pack source lock schema v2', () => {
  it('reports CLI verification failures with a fixed path-free message', async () => {
    const stderr: string[] = []
    const secret = '/private/source-lock/customer-name/sources.lock.json'

    const exitCode = await loadConverterSourceLockMain(['--lock', secret, '--target', 'darwin-arm64'], {
      stdout: { write: () => { throw new Error('unexpected stdout') } },
      stderr: { write: (value: string) => { stderr.push(value); return true } },
      load: async () => { throw new Error(`failed to read ${secret}`) },
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['converter source lock verification failed\n'])
    expect(stderr.join('')).not.toContain(secret)
  })

  it('selects exact engine, formula, license, and authenticated closure coordinates', async () => {
    const path = writeLock(temporaryRoot(), fixture())

    const selected = await loadConverterSourceLock({ path, target: 'darwin-arm64' })

    expect(selected).toEqual({
      target: 'darwin-arm64',
      homebrewCoreRevision: '1'.repeat(40),
      homebrewCaskRevision: '2'.repeat(40),
      engines: expect.arrayContaining([
        {
          name: 'ffmpeg', version: '9.0.1+1', license: 'GPL-3.0-or-later', rootFormula: 'ffmpeg',
          acquisition: bottle('ffmpeg', 'darwin-arm64', 'a', 100),
          licenses: [],
        },
        {
          name: 'libreoffice', version: '26.8.0', license: 'MPL-2.0', rootFormula: null,
          acquisition: {
            kind: 'dmg', url: 'https://downloads.example.test/libreoffice-darwin-arm64.dmg',
            sha256: 'b'.repeat(64), bytes: 140, cellar: null,
          },
          licenses: [{
            kind: 'download', url: 'https://downloads.example.test/libreoffice-LICENSE',
            sha256: '9'.repeat(64), bytes: 15, destination: 'licenses/libreoffice.LICENSE',
          }],
        },
      ]),
      formulae: expect.arrayContaining([
        {
          name: 'ffmpeg', version: '9.0.1+1', revision: 0, license: 'MIT',
          acquisition: bottle('ffmpeg', 'darwin-arm64', 'a', 100),
          licenses: [{
            kind: 'bottle-entry', target: 'darwin-arm64', path: 'LICENSE', sha256: 'a'.repeat(64),
            bytes: 12, destination: 'licenses/ffmpeg.LICENSE',
          }],
        },
      ]),
      closureLock: { path: 'closures/darwin-arm64.lock.json', sha256: '6'.repeat(64), bytes: 600 },
    })
    expect(Object.isFrozen(selected)).toBe(true)
    expect(Object.isFrozen(selected.formulae[0])).toBe(true)
    expect(Object.isFrozen(selected.formulae[0]?.acquisition)).toBe(true)
  })

  it('rejects noncanonical JSON and schema v1', async () => {
    const root = temporaryRoot()
    const path = writeLock(root, fixture())
    writeFileSync(path, `${JSON.stringify(fixture(), null, 2)}\n`)
    await expect(loadConverterSourceLock({ path, target: 'darwin-arm64' }))
      .rejects.toThrow('Source lock is not canonical JSON.')

    const v1 = fixture() as Record<string, unknown>
    v1.schemaVersion = 1
    await expect(loadConverterSourceLock({ path: writeLock(temporaryRoot(), v1), target: 'darwin-arm64' }))
      .rejects.toThrow('Source lock has an invalid schema.')
  })

  it.each([
    ['unknown top-level key', (value: ReturnType<typeof fixture>) => { Object.assign(value, { typo: true }) }],
    ['unsorted formulae', (value: ReturnType<typeof fixture>) => { value.formulae.reverse() }],
    ['duplicate formula', (value: ReturnType<typeof fixture>) => { value.formulae[1] = structuredClone(value.formulae[0]!) }],
    ['root coordinate disagreement', (value: ReturnType<typeof fixture>) => { value.engines[0]!.acquisitions['darwin-arm64'].bytes += 1 }],
    ['unsafe formula version segment', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.version = '../2.86.0' }],
    ['unsafe engine version segment', (value: ReturnType<typeof fixture>) => { value.engines[0]!.version = '/9.0.1' }],
    ['dot formula version', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.version = '.' }],
    ['dot-dot engine version', (value: ReturnType<typeof fixture>) => { value.engines[1]!.version = '..' }],
    ['backslash formula version', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.version = '2.86\\0' }],
    ['oversized formula version', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.version = 'v'.repeat(129) }],
    ['non-NFC engine version', (value: ReturnType<typeof fixture>) => { value.engines[0]!.version = 'e\u0301' }],
    ['null bottle root', (value: ReturnType<typeof fixture>) => { value.engines[0]!.rootFormula = null }],
    ['LibreOffice formula root', (value: ReturnType<typeof fixture>) => { value.engines[1]!.rootFormula = 'glib' }],
    ['missing LibreOffice license', (value: ReturnType<typeof fixture>) => { value.engines[1]!.licenses = [] }],
    ['duplicate engine license destination', (value: ReturnType<typeof fixture>) => {
      value.engines[1]!.licenses.push({
        kind: 'download', url: 'https://downloads.example.test/libreoffice-NOTICE',
        sha256: '8'.repeat(64), bytes: 8, destination: 'LICENSES/LIBREOFFICE.license',
      })
    }],
    ['formula-backed engine license', (value: ReturnType<typeof fixture>) => {
      value.engines[0]!.licenses = structuredClone(value.engines[1]!.licenses)
    }],
    ['HTTP coordinate', (value: ReturnType<typeof fixture>) => { value.formulae[0]!.acquisitions['darwin-arm64']!.url = 'http://example.test/file' }],
    ['uppercase URL protocol', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.acquisitions['darwin-arm64']!.url = 'HTTPS://downloads.example.test/glib.tar.gz' }],
    ['uppercase URL host', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.acquisitions['darwin-arm64']!.url = 'https://DOWNLOADS.example.test/glib.tar.gz' }],
    ['default HTTPS port', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.acquisitions['darwin-arm64']!.url = 'https://downloads.example.test:443/glib.tar.gz' }],
    ['URL internal newline', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.acquisitions['darwin-arm64']!.url = 'https://downloads.example.test/glib\n.tar.gz' }],
    ['URL raw space', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.acquisitions['darwin-arm64']!.url = 'https://downloads.example.test/glib file.tar.gz' }],
    ['URL backslash', (value: ReturnType<typeof fixture>) => { value.formulae[1]!.acquisitions['darwin-arm64']!.url = 'https://downloads.example.test\\glib.tar.gz' }],
    ['invalid SHA', (value: ReturnType<typeof fixture>) => { value.formulae[0]!.acquisitions['darwin-arm64']!.sha256 = 'ABC' }],
    ['zero bytes', (value: ReturnType<typeof fixture>) => { value.formulae[0]!.acquisitions['darwin-arm64']!.bytes = 0 }],
    ['unsafe license destination', (value: ReturnType<typeof fixture>) => { value.formulae[0]!.licenses[0]!.destination = '../LICENSE' }],
    ['duplicate case-folded license destination', (value: ReturnType<typeof fixture>) => {
      value.formulae[0]!.licenses.push({
        kind: 'download', url: 'https://example.test/license', sha256: '9'.repeat(64), bytes: 3,
        destination: 'LICENSES/FFMPEG.license',
      } as never)
    }],
    ['unsafe closure path', (value: ReturnType<typeof fixture>) => { value.closureLocks['darwin-arm64'].path = '../arm64.json' }],
  ])('rejects %s', async (_label, mutate) => {
    const value = fixture()
    mutate(value)
    const path = writeLock(temporaryRoot(), value)
    await expect(loadConverterSourceLock({ path, target: 'darwin-arm64' }))
      .rejects.toThrow('Source lock has an invalid schema.')
  })

  it('rejects an unsupported caller target', async () => {
    const path = writeLock(temporaryRoot(), fixture())
    await expect(loadConverterSourceLock({ path, target: 'linux-x64' }))
      .rejects.toThrow('Source lock target is unsupported.')
  })
})
