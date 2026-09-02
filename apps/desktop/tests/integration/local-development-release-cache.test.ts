import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateDevelopmentRelease,
  createDevelopmentPreparationWorkspace,
  developmentReleasePaths,
  fingerprintDevelopmentRelease,
  readActiveDevelopmentRelease,
  recoverInterruptedActiveReplacement,
  replaceActiveDevelopmentRelease,
  removeInactiveDevelopmentRelease,
  writeDevelopmentReleaseMetadata,
} from '../../scripts/converter-packs/local-development-release-cache.mjs'
import { canonicalBytes } from '../../scripts/converter-packs/pack-tooling-lib.mjs'

const roots: string[] = []
const children = new Set<ReturnType<typeof spawn>>()
const testBirth = 'Tue Jan  2 00:00:00 2024'
const testProcessIdentity = async (pid: number) => pid === process.pid ? testBirth : undefined

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  children.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolvePromise, rejectPromise) => {
    const check = () => {
      if (predicate()) resolvePromise()
      else if (Date.now() - started >= timeoutMs) rejectPromise(new Error('Timed out waiting for release mutation state.'))
      else setTimeout(check, 20)
    }
    check()
  })
}

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-development-release-cache-')))
  roots.push(root)
  return root
}

function createRelease(cacheRoot: string, fingerprint: string): string {
  const release = join(cacheRoot, 'releases', fingerprint)
  mkdirSync(release, { recursive: true })
  return release
}

function createReadyWorkspace(
  cacheRoot: string,
  fingerprint: string,
  index: number,
  { age = Date.now() / 1000, birth = 'Tue Jan  2 00:00:00 2024' } = {},
) {
  const nonce = randomUUID()
  const path = join(cacheRoot, `.local-development-preparation-${fingerprint}-A${String(index).padStart(5, '0')}`)
  mkdirSync(path)
  const owner = join(path, `.owner-${nonce}.ready`)
  writeFileSync(owner, canonicalBytes({ birth, fingerprint, nonce, pid: process.pid, schemaVersion: 2 }))
  chmodSync(owner, 0o444)
  utimesSync(owner, age, age)
  return path
}

describe('local development release cache', () => {
  it.each([
    ['create', 'afterWorkspaceCreateForTest'],
    ['write', 'afterOwnerWriteForTest'],
    ['fsync', 'afterOwnerFileSyncForTest'],
    ['ready', 'afterOwnerReadyForTest'],
  ] as const)('never exposes a partial owner after %s failure and permits a clean retry', async (_phase, hook) => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = '8'.repeat(64)
    await expect(createDevelopmentPreparationWorkspace({
      cacheRoot,
      fingerprint,
      processIdentity: testProcessIdentity,
      [hook]: async () => { throw new Error(`owner ${_phase} failure`) },
    })).rejects.toThrow(`owner ${_phase} failure`)
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.local-development-preparation-'))).toEqual([])

    const lease = await createDevelopmentPreparationWorkspace({ cacheRoot, fingerprint, processIdentity: testProcessIdentity })
    expect(readdirSync(lease.path).filter((name) => name.endsWith('.ready'))).toHaveLength(1)
    await lease.stop()
    rmSync(lease.path, { recursive: true })
  })

  it.each([
    ['writing', 'afterOwnerFileSyncForTest'],
    ['ready', 'afterOwnerReadyForTest'],
  ] as const)('recovers a %s owner left by SIGKILL', async (_phase, hook) => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = '7'.repeat(64)
    const marker = join(root, `${_phase}-marker`)
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, marker, hook, birth] = process.argv.slice(1)
      const { createDevelopmentPreparationWorkspace } = await import(moduleUrl)
      await createDevelopmentPreparationWorkspace({
        cacheRoot,
        fingerprint,
        processIdentity: async () => birth,
        [hook]: async () => {
          await writeFile(marker, 'ready')
          await new Promise(() => globalThis.setInterval(() => {}, 1_000))
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, fingerprint, marker, hook, testBirth,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
    await waitUntil(() => existsSync(marker))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
    children.delete(child)

    const lease = await createDevelopmentPreparationWorkspace({ cacheRoot, fingerprint, processIdentity: testProcessIdentity })
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.local-development-preparation-'))).toEqual([
      lease.path.split('/').at(-1),
    ])
    await lease.stop()
    rmSync(lease.path, { recursive: true })
  })

  it('globally reclaims a cross-fingerprint reused PID owner before enforcing the eight-workspace bound', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const expired = createReadyWorkspace(cacheRoot, '0'.repeat(64), 0, { birth: 'Mon Jan  1 00:00:00 2024' })
    for (let index = 1; index < 8; index += 1) createReadyWorkspace(cacheRoot, index.toString(16).repeat(64), index)
    const processIdentity = async () => 'Tue Jan  2 00:00:00 2024'

    const eighth = await createDevelopmentPreparationWorkspace({
      cacheRoot,
      fingerprint: '8'.repeat(64),
      processIdentity,
    })
    expect(existsSync(expired)).toBe(false)
    await eighth.stop()
    await expect(createDevelopmentPreparationWorkspace({
      cacheRoot,
      fingerprint: '9'.repeat(64),
      processIdentity,
    }))
      .rejects.toThrow(/limit/iu)
    rmSync(eighth.path, { recursive: true })
  })

  it('protects an exact live process owner after a 31-second wall-clock jump', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = '5'.repeat(64)
    const birth = 'Mon Jan  1 00:00:00 2024'
    const live = createReadyWorkspace(cacheRoot, fingerprint, 0, { age: Date.now() / 1000 - 31, birth })
    const lease = await createDevelopmentPreparationWorkspace({
      cacheRoot,
      fingerprint,
      processIdentity: async () => birth,
    })

    expect(existsSync(live)).toBe(true)
    await lease.stop()
    rmSync(lease.path, { recursive: true })
  })

  it('fences an owner lease whose stable inode grows behind the open handle', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = '6'.repeat(64)
    const lease = await createDevelopmentPreparationWorkspace({ cacheRoot, fingerprint, processIdentity: testProcessIdentity })
    const owner = join(lease.path, readdirSync(lease.path).find((name) => name.endsWith('.ready'))!)
    const bytes = readFileSync(owner)
    chmodSync(owner, 0o644)
    writeFileSync(owner, Buffer.concat([bytes, Buffer.from('evil')]))
    chmodSync(owner, 0o444)

    await expect(lease.pulse()).rejects.toThrow(/lease was lost/iu)
    await lease.stop().catch(() => undefined)
    rmSync(lease.path, { recursive: true })
  })
  it('frames the development release fingerprint deterministically', () => {
    expect(fingerprintDevelopmentRelease({
      target: 'darwin-arm64',
      inputs: [
        { path: 'a', bytes: Buffer.from('one') },
        { path: 'b', bytes: Buffer.from('two') },
      ],
    })).toBe('ff854d97f63725260c0c5cc96dde6006aa48f8db5912303ec6532bc0d6a355af')
  })

  it('canonicalizes input order and distinguishes targets and bytes', () => {
    const inputs = [
      { path: 'a', bytes: Buffer.from('one') },
      { path: 'b', bytes: Buffer.from('two') },
    ]
    const fingerprint = fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs })

    expect(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs: [...inputs].reverse() })).toBe(fingerprint)
    expect(fingerprintDevelopmentRelease({ target: 'darwin-x64', inputs })).not.toBe(fingerprint)
    expect(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs: [{ path: 'a', bytes: Buffer.from('ONE') }, inputs[1]] })).not.toBe(fingerprint)
  })

  it('uses a strict bytewise order for distinct Unicode paths', () => {
    const inputs = [
      { path: 'e\u0301', bytes: Buffer.from('one') },
      { path: 'é', bytes: Buffer.from('two') },
    ]

    expect(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs: [...inputs].reverse() }))
      .toBe(fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs }))
  })

  it('rejects unsafe or duplicate fingerprint input paths', () => {
    for (const inputs of [
      [{ path: '../escape', bytes: Buffer.alloc(0) }],
      [{ path: '/absolute', bytes: Buffer.alloc(0) }],
      [{ path: 'nested//path', bytes: Buffer.alloc(0) }],
      [{ path: 'a', bytes: Buffer.alloc(0) }, { path: 'a', bytes: Buffer.alloc(1) }],
    ]) {
      expect(() => fingerprintDevelopmentRelease({ target: 'darwin-arm64', inputs })).toThrow(/path|duplicate|safe/iu)
    }
  })

  it('returns canonical cache paths and rejects a symbolic root', () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = 'a'.repeat(64)
    const paths = developmentReleasePaths(cacheRoot, fingerprint)

    expect(paths).toMatchObject({
      sources: join(cacheRoot, 'sources'),
      release: join(cacheRoot, 'releases', fingerprint),
      activeMarker: join(cacheRoot, 'active-release.json'),
    })
    expect(paths.markerTemporaryRoot.startsWith(`${cacheRoot}/.`)).toBe(true)

    const alias = join(root, 'cache-alias')
    symlinkSync(cacheRoot, alias)
    expect(() => developmentReleasePaths(alias, fingerprint)).toThrow(/symbolic|canonical|root/iu)
  })

  it('reads only a canonical marker for an existing in-tree release', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const fingerprint = 'b'.repeat(64)
    const release = createRelease(cacheRoot, fingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)

    await expect(readActiveDevelopmentRelease({ cacheRoot })).resolves.toBe(release)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${'c'.repeat(64)}","schemaVersion":1}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/release|exist/iu)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1,"extra":true}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/marker|schema|key/iu)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"schemaVersion":1,"fingerprint":"${fingerprint}"}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/marker|schema/iu)

    const externalRelease = join(temporaryRoot(), 'external-release')
    mkdirSync(externalRelease)
    rmSync(release, { recursive: true })
    symlinkSync(externalRelease, release)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).rejects.toThrow(/release|symbolic|inside/iu)
  })

  it('removes only a confirmed inactive release and never deletes a newly active winner', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    const oldFingerprint = '1'.repeat(64)
    const candidate = '2'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, candidate)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(removeInactiveDevelopmentRelease({ cacheRoot, fingerprint: candidate })).resolves.toBe(true)
    expect(existsSync(join(cacheRoot, 'releases', candidate))).toBe(false)

    createRelease(cacheRoot, candidate)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${candidate}","schemaVersion":1}\n`)
    await expect(removeInactiveDevelopmentRelease({ cacheRoot, fingerprint: candidate })).resolves.toBe(false)
    expect(existsSync(join(cacheRoot, 'releases', candidate))).toBe(true)
  })

  it('replaces a corrupt active release from a private candidate and rolls back before exposing failure', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = '3'.repeat(64)
    const active = createRelease(cacheRoot, fingerprint)
    writeFileSync(join(active, 'state'), 'corrupt')
    const marker = `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`
    writeFileSync(join(cacheRoot, 'active-release.json'), marker)
    const failedCandidate = join(cacheRoot, '.candidate-failed')
    mkdirSync(failedCandidate)
    writeFileSync(join(failedCandidate, 'state'), 'candidate')
    const syncs: Array<{ path: string, phase: string }> = []
    const syncDirectoryForTest = async (path: string, phase: string, run: () => Promise<void>) => {
      syncs.push({ path, phase })
      await run()
    }

    await expect(replaceActiveDevelopmentRelease({
      cacheRoot,
      fingerprint,
      candidateRelease: failedCandidate,
      afterOldReleaseRenameForTest: async () => { throw new Error('injected replacement failure') },
      syncDirectoryForTest,
    })).rejects.toThrow('injected replacement failure')
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(marker)
    expect(readFileSync(join(active, 'state'), 'utf8')).toBe('corrupt')
    expect(readFileSync(join(failedCandidate, 'state'), 'utf8')).toBe('candidate')
    expect(syncs).toEqual(expect.arrayContaining([
      { path: join(cacheRoot, 'releases'), phase: 'quarantine-source' },
      { path: cacheRoot, phase: 'quarantine-destination' },
      { path: cacheRoot, phase: 'rollback-source' },
      { path: join(cacheRoot, 'releases'), phase: 'rollback-destination' },
    ]))

    const candidate = join(cacheRoot, '.candidate-ready')
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'state'), 'verified')
    syncs.length = 0
    await expect(replaceActiveDevelopmentRelease({
      cacheRoot,
      fingerprint,
      candidateRelease: candidate,
      syncDirectoryForTest,
    }))
      .resolves.toBe(active)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(marker)
    expect(readFileSync(join(active, 'state'), 'utf8')).toBe('verified')
    expect(existsSync(candidate)).toBe(false)
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.replaced-active-release-'))).toEqual([])
    expect(syncs).toEqual(expect.arrayContaining([
      { path: join(cacheRoot, 'releases'), phase: 'quarantine-source' },
      { path: cacheRoot, phase: 'quarantine-destination' },
      { path: cacheRoot, phase: 'candidate-source' },
      { path: join(cacheRoot, 'releases'), phase: 'candidate-destination' },
    ]))
  })

  it.each([
    ['candidate rename', { afterCandidateRenameForTest: async () => { throw new Error('candidate rename tail failure') } }],
    ['quarantine delete', { afterQuarantineDeleteForTest: async () => { throw new Error('quarantine delete tail failure') } }],
    ['final directory fsync', {
      syncDirectoryForTest: async (path: string, phase: string, run: () => Promise<void>) => {
        if (phase === 'final') throw new Error('final directory fsync failure')
        await run()
      },
    }],
  ])('keeps the committed candidate active after a %s failure', async (_scenario, fault) => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = '5'.repeat(64)
    const active = createRelease(cacheRoot, fingerprint)
    writeFileSync(join(active, 'state'), 'corrupt')
    const marker = `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`
    writeFileSync(join(cacheRoot, 'active-release.json'), marker)
    const candidate = join(cacheRoot, `.candidate-${_scenario.replaceAll(' ', '-')}`)
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'state'), 'verified')

    await expect(replaceActiveDevelopmentRelease({
      cacheRoot,
      fingerprint,
      candidateRelease: candidate,
      ...fault,
    })).rejects.toThrow(/failure/)

    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(marker)
    expect(readFileSync(join(active, 'state'), 'utf8')).toBe('verified')
    expect(existsSync(candidate)).toBe(false)
    await expect(recoverInterruptedActiveReplacement({ cacheRoot })).resolves.toBeGreaterThanOrEqual(0)
    expect(readFileSync(join(active, 'state'), 'utf8')).toBe('verified')
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.replaced-active-release-'))).toEqual([])
  })

  it('recovers an old release after SIGKILL between its cross-directory rename and candidate commit', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const fingerprint = '4'.repeat(64)
    const active = createRelease(cacheRoot, fingerprint)
    writeFileSync(join(active, 'state'), 'previous')
    const markerBytes = `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`
    writeFileSync(join(cacheRoot, 'active-release.json'), markerBytes)
    const candidate = join(cacheRoot, '.candidate-killed')
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'state'), 'candidate')
    const marker = join(root, 'old-release-renamed')
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, candidate, marker] = process.argv.slice(1)
      const { replaceActiveDevelopmentRelease } = await import(moduleUrl)
      await replaceActiveDevelopmentRelease({
        cacheRoot,
        fingerprint,
        candidateRelease: candidate,
        afterOldReleaseRenameForTest: async () => {
          await writeFile(marker, 'ready')
          await new Promise(() => globalThis.setInterval(() => {}, 1_000))
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, fingerprint, candidate, marker,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
    await waitUntil(() => existsSync(marker))
    child.kill('SIGKILL')
    await closed
    children.delete(child)

    await expect(recoverInterruptedActiveReplacement({ cacheRoot })).resolves.toBe(1)
    expect(readFileSync(join(active, 'state'), 'utf8')).toBe('previous')
    expect(readFileSync(join(candidate, 'state'), 'utf8')).toBe('candidate')
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(markerBytes)
  })

  it('restores an active release from a bounded interrupted replacement quarantine', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'releases'), { recursive: true })
    const fingerprint = '4'.repeat(64)
    const marker = `{"fingerprint":"${fingerprint}","schemaVersion":1}\n`
    writeFileSync(join(cacheRoot, 'active-release.json'), marker)
    const quarantine = join(cacheRoot, `.replaced-active-release-${fingerprint}-123e4567-e89b-42d3-a456-426614174000`)
    mkdirSync(quarantine)
    writeFileSync(join(quarantine, 'state'), 'previous')

    await expect(recoverInterruptedActiveReplacement({ cacheRoot })).resolves.toBe(1)
    await expect(readActiveDevelopmentRelease({ cacheRoot })).resolves.toBe(join(cacheRoot, 'releases', fingerprint))
    expect(readFileSync(join(cacheRoot, 'releases', fingerprint, 'state'), 'utf8')).toBe('previous')
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(marker)
  })

  it('activates an existing release atomically without leaking marker temporaries', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const oldFingerprint = 'd'.repeat(64)
    const fingerprint = 'e'.repeat(64)
    const release = createRelease(cacheRoot, fingerprint)
    createRelease(cacheRoot, oldFingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(activateDevelopmentRelease({ cacheRoot, fingerprint })).resolves.toBe(release)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toBe(`{"fingerprint":"${fingerprint}","schemaVersion":1}\n`)
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.active-release-'))).toEqual([])
  })

  it('preserves the old marker when the final rename fails', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const oldFingerprint = 'f'.repeat(64)
    const fingerprint = '0'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, fingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(activateDevelopmentRelease({ cacheRoot, fingerprint }, {
      rename: async () => { throw new Error('rename failed') },
    })).rejects.toThrow('rename failed')
    await expect(readActiveDevelopmentRelease({ cacheRoot })).resolves.toBe(join(cacheRoot, 'releases', oldFingerprint))
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.active-release-'))).toEqual([])
  })

  it('publishes immutable metadata only for a canonical existing release and complete blobs', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    const fingerprint = '1'.repeat(64)
    const blob = createHash('sha256').update('blob').digest('hex')
    createRelease(cacheRoot, fingerprint)
    writeFileSync(join(cacheRoot, 'sources', `${blob}.archive`), 'blob')

    const metadata = await writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint, blobs: [{ sha256: blob, bytes: 4 }],
    })
    expect(readFileSync(metadata, 'utf8')).toBe(
      `{"blobs":[{"bytes":4,"sha256":"${blob}"}],"fingerprint":"${fingerprint}","release":"releases/${fingerprint}","schemaVersion":1}`,
    )
    await expect(writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint, blobs: [{ sha256: blob, bytes: 4 }],
    })).resolves.toBe(metadata)

    const alias = join(cacheRoot, 'sources', 'alias.archive')
    symlinkSync(join(cacheRoot, 'sources', `${blob}.archive`), alias)
    await expect(writeDevelopmentReleaseMetadata({
      cacheRoot, fingerprint: '3'.repeat(64), blobs: [{ sha256: 'alias', bytes: 4, path: alias }],
    })).rejects.toThrow()
  })

  it('fails closed when existing release metadata does not match the requested payload', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    mkdirSync(join(cacheRoot, 'release-metadata'))
    const fingerprint = '3'.repeat(64)
    createRelease(cacheRoot, fingerprint)
    const metadata = join(cacheRoot, 'release-metadata', `${fingerprint}.json`)
    writeFileSync(metadata, 'wrong', { mode: 0o444 })

    await expect(writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint, blobs: [] }))
      .rejects.toThrow(/metadata|match|unsafe/iu)
    expect(readFileSync(metadata, 'utf8')).toBe('wrong')
  })

  it('serializes public activation against pruning so the marker never names a deleted release', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(join(cacheRoot, 'sources'), { recursive: true })
    const oldFingerprint = '4'.repeat(64)
    const nextFingerprint = '5'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, nextFingerprint)
    await writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint: oldFingerprint, blobs: [] })
    await writeDevelopmentReleaseMetadata({ cacheRoot, fingerprint: nextFingerprint, blobs: [] })
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)
    const marker = join(cacheRoot, 'activation-ready')
    const release = join(cacheRoot, 'activation-release')
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { access, writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, marker, release] = process.argv.slice(1)
      const { activateDevelopmentRelease } = await import(moduleUrl)
      await activateDevelopmentRelease({ cacheRoot, fingerprint }, {
        beforePublishForTest: async () => {
          await writeFile(marker, 'ready')
          while (true) {
            try { await access(release); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
          }
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, nextFingerprint, marker, release,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    await waitUntil(() => existsSync(marker))
    const { pruneDevelopmentCache } = await import('../../scripts/converter-packs/development-cache-budget.mjs')
    await expect(pruneDevelopmentCache({ cacheRoot, activeFingerprint: oldFingerprint, maximumBlobBytes: 1 }))
      .rejects.toThrow('already claimed')
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(oldFingerprint)
    expect(existsSync(join(cacheRoot, 'releases', oldFingerprint))).toBe(true)
    writeFileSync(release, 'release')
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once('error', rejectPromise)
      child.once('close', (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`activation child ${code}`)))
    })
    children.delete(child)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(nextFingerprint)
    expect(existsSync(join(cacheRoot, 'releases', nextFingerprint))).toBe(true)
  })

  it('fences an initializer resumed after another process takes over its incomplete claim', async () => {
    const root = temporaryRoot()
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const delayed = '6'.repeat(64)
    const winner = '7'.repeat(64)
    createRelease(cacheRoot, delayed)
    createRelease(cacheRoot, winner)
    const ready = join(root, 'claim-ready')
    const resume = join(root, 'claim-resume')
    const moduleUrl = new URL('../../scripts/converter-packs/local-development-release-cache.mjs', import.meta.url).href
    const script = String.raw`
      import { access, writeFile } from 'node:fs/promises'
      const [moduleUrl, cacheRoot, fingerprint, ready, resume] = process.argv.slice(1)
      const { activateDevelopmentRelease } = await import(moduleUrl)
      await activateDevelopmentRelease({ cacheRoot, fingerprint }, {
        afterClaimOpenForTest: async () => {
          await writeFile(ready, 'ready')
          while (true) {
            try { await access(resume); break } catch { await new Promise((resolve) => setTimeout(resolve, 20)) }
          }
        },
      })
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', script, moduleUrl, cacheRoot, delayed, ready, resume,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    children.add(child)
    await waitUntil(() => existsSync(ready))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    await activateDevelopmentRelease({ cacheRoot, fingerprint: winner })
    const closed = new Promise<number | null>((resolvePromise) => child.once('close', resolvePromise))
    writeFileSync(resume, 'resume')
    const exitCode = await closed
    children.delete(child)
    expect(exitCode).not.toBe(0)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(winner)
  })

  it('does not publish an activation marker after its mutation claim is deleted', async () => {
    const cacheRoot = join(temporaryRoot(), 'cache')
    mkdirSync(cacheRoot)
    const oldFingerprint = '8'.repeat(64)
    const nextFingerprint = '9'.repeat(64)
    createRelease(cacheRoot, oldFingerprint)
    createRelease(cacheRoot, nextFingerprint)
    writeFileSync(join(cacheRoot, 'active-release.json'), `{"fingerprint":"${oldFingerprint}","schemaVersion":1}\n`)

    await expect(activateDevelopmentRelease({ cacheRoot, fingerprint: nextFingerprint }, {
      beforePublishForTest: async () => unlinkSync(join(cacheRoot, '.cache-mutation.claim')),
    })).rejects.toThrow(/claim|lost/iu)
    expect(readFileSync(join(cacheRoot, 'active-release.json'), 'utf8')).toContain(oldFingerprint)
  })
})
