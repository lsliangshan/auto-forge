// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { signReleaseManifest } from '@autoforge/workflow-contracts/node'
import type { ReleaseManifest, SignedRelease } from '@autoforge/workflow-contracts'
import { AppDatabase } from '../database/app-database'
import { WorkflowInstallationService } from './workflow-installation-service'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('WorkflowInstallationService', () => {
  it('verifies the signature and both hashes before changing the installed pointer', async () => {
    root = mkdtempSync(join(tmpdir(), 'autoforge-install-')); const keys = generateKeyPairSync('ed25519')
    const manifest = { schemaVersion: 1, sdkVersion: 1, slug: 'fixture', name: 'Fixture', description: 'Fixture workflow', version: '1.0.0', categorySlug: 'developer-tools', entry: 'dist/index.mjs', targetHosts: ['localhost'], permissions: ['browser.read'] } as const
    const code = strToU8('export async function run(){return {ok:true}}'); const archive = Buffer.from(zipSync({ 'workflow.json': strToU8(JSON.stringify(manifest)), 'dist/index.mjs': code }, { level: 9, mtime: new Date('1980-01-01T00:00:00.000Z') }))
    const sha = async (value: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', value)).toString('hex')
    const release: ReleaseManifest = { schemaVersion: 1, workflowId: 'wf-1', slug: 'fixture', version: '1.0.0', entry: 'dist/index.mjs', codeSha256: await sha(code), packageSha256: await sha(archive), permissions: ['browser.read'], targetHosts: ['localhost'], publishedAt: '2026-07-19T00:00:00.000Z' }
    const ticket: SignedRelease = { keyId: 'test', manifest: release, signature: signReleaseManifest(release, keys.privateKey), downloadUrl: 'https://objects.test/release.zip', expiresAt: '2026-07-19T01:00:00.000Z' }
    const registry = { downloadTicket: async () => ticket, download: async () => archive }
    const db = new AppDatabase(':memory:'); db.initialize(); const service = new WorkflowInstallationService(db, registry as never, root, { test: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    await expect(service.install('wf-1', '1.0.0')).resolves.toMatchObject({ version: '1.0.0' })
    registry.download = async () => Buffer.from([...archive.slice(0, -1), archive.at(-1)! ^ 1])
    await expect(service.install('wf-1', '1.0.0')).rejects.toThrow(/hash/i)
    expect(db.getInstalledWorkflow('wf-1')?.version).toBe('1.0.0'); db.close()
  })
})
