import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'
import { signPackPayloads } from '../../scripts/converter-packs/sign-pack-payload.mjs'
import { verifyReleaseEvidence } from '../../scripts/converter-packs/verify-release-evidence.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const sourceLockPath = join(desktopRoot, 'converter-packs', 'sources.lock.json')
const temporaryRoots: string[] = []
const familyEngine = {
  'image-icon': 'libvips',
  document: 'libreoffice',
  pdf: 'poppler',
  media: 'ffmpeg',
} as const

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-release-evidence-')))
  temporaryRoots.push(root)
  return root
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stageFixture(root: string): string {
  const staging = join(root, 'release-input')
  mkdirSync(join(staging, 'packs'), { recursive: true })
  writeFileSync(join(staging, 'release.json'), canonicalBytes({
    schemaVersion: 1, generatedAt: '2026-08-31T00:00:00.000Z', sequence: 17,
  }))
  for (const name of Object.keys(familyEngine)) {
    const pack = join(staging, 'packs', `${name}-darwin-arm64`)
    const executablePath = name === 'document' ? 'program/soffice' : `bin/${name}`
    const files = [
      { path: executablePath, role: 'executable' },
      { path: `lib/lib${name}.dylib`, role: 'code' },
      { path: `LICENSES/${familyEngine[name as keyof typeof familyEngine]}.txt`, role: 'license' },
    ]
    for (const file of files) {
      const path = join(pack, 'payload', ...file.path.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${name}:${file.path}\n`)
      chmodSync(path, file.role === 'executable' ? 0o755 : 0o644)
    }
    writeFileSync(join(pack, 'pack.json'), canonicalBytes({
      schemaVersion: 1, name, version: '1.2.3', platform: 'darwin', arch: 'arm64',
      archiveUrl: `https://cdn.example.test/${name}-1.2.3-darwin-arm64.tar`, files,
    }))
  }
  return staging
}

function sourceOffers() {
  const lock = JSON.parse(readFileSync(sourceLockPath, 'utf8')) as { engines: Array<Record<string, unknown>> }
  return lock.engines.map((engine) => ({
    name: engine.name,
    version: engine.version,
    license: engine.license,
    url: (engine.source as { url: string }).url,
    sha256: (engine.source as { sha256: string }).sha256,
  }))
}

function evidenceFixture(staging: string) {
  const files = []
  for (const name of Object.keys(familyEngine)) {
    const pack = join(staging, 'packs', `${name}-darwin-arm64`)
    const manifest = JSON.parse(readFileSync(join(pack, 'pack.json'), 'utf8')) as { files: Array<{ path: string; role: string }> }
    for (const file of manifest.files) {
      const bytes = readFileSync(join(pack, 'payload', ...file.path.split('/')))
      files.push({
        pack: name,
        path: file.path,
        role: file.role,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
        ...(file.role === 'code' || file.role === 'executable'
          ? { architecture: 'arm64', signed: true, hardenedRuntime: true }
          : {}),
      })
    }
  }
  return {
    schemaVersion: 1,
    target: 'darwin-arm64',
    generatedAt: '2026-08-31T00:00:00.000Z',
    teamId: 'TEAM123456',
    notarization: { id: 'notary-request-id', status: 'Accepted' },
    toolVersions: { codesign: 'codesign-1', notarytool: 'notarytool-1' },
    sourceOffers: sourceOffers(),
    files,
  }
}

describe('converter pack release evidence', () => {
  it('accepts complete canonical evidence and rejects every release gate mutation', async () => {
    const root = temporaryRoot()
    const staging = stageFixture(root)
    const evidencePath = join(root, 'evidence.json')
    const valid = evidenceFixture(staging)
    writeFileSync(evidencePath, canonicalBytes(valid))
    await expect(verifyReleaseEvidence({ stagingRoot: staging, evidencePath, expectedTeamId: 'TEAM123456' })).resolves.toBeUndefined()

    for (const [label, mutate] of [
      ['wrong team', (value: typeof valid) => { value.teamId = 'WRONGTEAM' }],
      ['not accepted', (value: typeof valid) => { value.notarization.status = 'Invalid' }],
      ['missing source', (value: typeof valid) => { value.sourceOffers.pop() }],
      ['missing license', (value: typeof valid) => { value.files = value.files.filter((file) => file.role !== 'license') }],
      ['wrong architecture', (value: typeof valid) => { const file = value.files.find((entry) => entry.role === 'code')!; file.architecture = 'x86_64' }],
      ['unsigned', (value: typeof valid) => { const file = value.files.find((entry) => entry.role === 'executable')!; file.signed = false }],
      ['no hardened runtime', (value: typeof valid) => { const file = value.files.find((entry) => entry.role === 'code')!; file.hardenedRuntime = false }],
    ] as const) {
      const mutated = structuredClone(valid)
      mutate(mutated)
      writeFileSync(evidencePath, canonicalBytes(mutated))
      await expect(verifyReleaseEvidence({ stagingRoot: staging, evidencePath, expectedTeamId: 'TEAM123456' }), label).rejects.toThrow()
    }
  })

  it('signs inside-out, records only allowlisted evidence, and fails closed without credentials', async () => {
    const root = temporaryRoot()
    const staging = stageFixture(root)
    const evidencePath = join(root, 'signed-evidence.json')
    const wrapper = join(root, 'notarization.zip')
    const calls: Array<{ executable: string; args: readonly string[] }> = []
    const secret = 'PRIVATE-SENTINEL-DO-NOT-SERIALIZE'
    const oldSecret = process.env.AUTOFORGE_PRIVATE_SENTINEL
    process.env.AUTOFORGE_PRIVATE_SENTINEL = secret
    try {
      await signPackPayloads({
        stagingRoot: staging,
        evidencePath,
        sourceLockPath,
        target: 'darwin-arm64',
        identity: 'Developer ID Application: Example (TEAM123456)',
        teamId: 'TEAM123456',
        keychainProfile: 'autoforge-notary',
        generatedAt: '2026-08-31T00:00:00.000Z',
      }, {
        run: async (executable: string, args: readonly string[]) => {
          calls.push({ executable, args })
          return { status: 0, stdout: '', stderr: '' }
        },
        createWrapper: async () => { writeFileSync(wrapper, 'wrapper'); return wrapper },
        notarize: async () => ({ id: 'notary-request-id', status: 'Accepted' }),
        inspectSignature: async () => ({ teamId: 'TEAM123456', hardenedRuntime: true, signed: true }),
        toolVersions: async () => ({ codesign: 'codesign-1', notarytool: 'notarytool-1' }),
      })
    } finally {
      if (oldSecret === undefined) delete process.env.AUTOFORGE_PRIVATE_SENTINEL
      else process.env.AUTOFORGE_PRIVATE_SENTINEL = oldSecret
    }

    const signPaths = calls.filter(({ executable, args }) => executable === '/usr/bin/codesign' && args.includes('--sign')).map(({ args }) => args.at(-1))
    expect(signPaths.slice(0, 4).every((path) => path?.endsWith('.dylib'))).toBe(true)
    expect(readFileSync(evidencePath, 'utf8')).not.toContain(secret)
    await expect(verifyReleaseEvidence({ stagingRoot: staging, evidencePath, expectedTeamId: 'TEAM123456' })).resolves.toBeUndefined()

    await expect(signPackPayloads({
      stagingRoot: staging, evidencePath: join(root, 'missing.json'), sourceLockPath,
      target: 'darwin-arm64', identity: '', teamId: '', keychainProfile: '',
      generatedAt: '2026-08-31T00:00:00.000Z',
    }, {})).rejects.toThrow(/credential/iu)
  })
})
