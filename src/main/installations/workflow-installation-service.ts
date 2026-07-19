import { createHash, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import { parseWorkflowManifest, type SignedRelease } from '@autoforge/workflow-contracts'
import { verifyReleaseManifest } from '@autoforge/workflow-contracts/node'
import type { InstalledWorkflow } from '../../shared/contracts'
import type { AppDatabase } from '../database/app-database'
import type { RegistryClient } from '../registry/registry-client'

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

export class WorkflowInstallationService {
  constructor(private readonly database: AppDatabase, private readonly registry: RegistryClient, private readonly root: string, private readonly trustedKeys: Record<string, string>) {}
  list(): InstalledWorkflow[] { return this.database.listInstalledWorkflows().map(({ workflowId, slug, version, installedAt }) => ({ workflowId, slug, version, installedAt })) }
  entry(workflowId: string): { path: string; manifest: ReturnType<typeof parseWorkflowManifest> } {
    const item = this.database.getInstalledWorkflow(workflowId); if (!item) throw new Error('Workflow is not installed')
    return { path: join(item.installPath, 'dist/index.mjs'), manifest: parseWorkflowManifest(JSON.parse(item.manifestJson)) }
  }
  async install(workflowId: string, version: string): Promise<InstalledWorkflow> {
    const ticket = await this.registry.downloadTicket(workflowId, version); this.verifyTicket(ticket)
    const archive = await this.registry.download(ticket.downloadUrl)
    if (hash(archive) !== ticket.manifest.packageSha256) throw new Error('Workflow package hash mismatch')
    const entries = unzipSync(archive); const allowed = new Set(['workflow.json', 'dist/index.mjs'])
    for (const path of Object.keys(entries)) if (path.includes('..') || path.startsWith('/') || path.includes('\\') || !allowed.has(path)) throw new Error(`Unsafe package path: ${path}`)
    if (!entries['workflow.json'] || !entries['dist/index.mjs']) throw new Error('Workflow package is incomplete')
    const manifest = parseWorkflowManifest(JSON.parse(Buffer.from(entries['workflow.json']).toString('utf8')))
    if (manifest.slug !== ticket.manifest.slug || manifest.version !== ticket.manifest.version || hash(entries['dist/index.mjs']) !== ticket.manifest.codeSha256) throw new Error('Workflow code hash mismatch')
    const workflowRoot = resolve(this.root, workflowId); mkdirSync(workflowRoot, { recursive: true })
    const temporary = join(workflowRoot, `.install-${Date.now()}`); const target = join(workflowRoot, version)
    mkdirSync(join(temporary, 'dist'), { recursive: true }); writeFileSync(join(temporary, 'workflow.json'), entries['workflow.json']); writeFileSync(join(temporary, 'dist/index.mjs'), entries['dist/index.mjs'])
    try { if (!existsSync(target)) renameSync(temporary, target); else rmSync(temporary, { recursive: true, force: true })
      const installedAt = new Date().toISOString(); this.database.markWorkflowInstalled({ workflowId, slug: manifest.slug, version, installPath: target, manifestJson: JSON.stringify(manifest), installedAt }); return { workflowId, slug: manifest.slug, version, installedAt }
    } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error }
  }
  private verifyTicket(ticket: SignedRelease) { const key = this.trustedKeys[ticket.keyId]; if (!key) throw new Error(`Unknown release key: ${ticket.keyId}`); if (!verifyReleaseManifest(ticket.manifest, ticket.signature, createPublicKey(key))) throw new Error('Workflow release signature is invalid') }
}
