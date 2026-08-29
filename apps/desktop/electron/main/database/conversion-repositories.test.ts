import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openAppDatabase } from './client.js'

const temporaryDirectories: string[] = []

function openTestDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'autoforge-conversion-repositories-'))
  const path = join(directory, 'autoforge.sqlite')
  temporaryDirectories.push(directory)
  return { database: openAppDatabase(path), path }
}

function createExecution(
  database: ReturnType<typeof openAppDatabase>,
  id: string,
  ownerUserId = 'alice',
) {
  return database.executions.insert({
    id,
    ownerUserId,
    workflowId: 'file.convert.universal',
    workflowVersion: '1.0.0',
    status: 'running',
    createdAt: 1,
  })
}

function createJob(
  database: ReturnType<typeof openAppDatabase>,
  id: string,
  executionId: string,
  createdAt: number,
  status: 'queued' | 'downloading_component' | 'converting' | 'verifying' = 'queued',
) {
  return database.conversionJobs.create({
    id,
    ownerUserId: 'alice',
    executionId,
    sourceKind: 'media',
    sourceId: `source_${id}`,
    targetFormat: 'png',
    status,
    createdAt,
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('conversion repositories', () => {
  it('atomically completes one epoch with all output artifacts or none', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_atomic_outputs')
    const job = createJob(database, 'job_atomic_outputs', 'execution_atomic_outputs', 1, 'verifying')
    const artifacts = [1, 2, 3].map((page) => ({
      id: `artifact_page_${page}`, ownerUserId: 'alice', executionId: 'execution_atomic_outputs',
      conversionJobId: job.id, role: 'output' as const, displayName: `report-page-00${page}.png`,
      detectedFormat: 'png', mimeType: 'image/png', byteSize: 12, sha256: String(page).repeat(64),
      relativePath: `results/artifact_page_${page}.png`, metadata: { pdfPage: page },
      status: 'ready' as const, createdAt: 10, updatedAt: 10,
    }))

    expect(database.conversionJobs.completeWithArtifacts({
      jobId: job.id, ownerUserId: 'alice', executionId: 'execution_atomic_outputs',
      expectedEpoch: 0, endedAt: 20, artifacts,
    })).toHaveLength(3)
    expect(database.conversionJobs.getOwned(job.id, 'alice')).toMatchObject({ status: 'completed', progress: 100, endedAt: 20 })
    expect(database.conversionArtifacts.listForJob(job.id, 'alice')).toHaveLength(3)

    const stale = createJob(database, 'job_stale_outputs', 'execution_atomic_outputs', 2, 'verifying')
    expect(database.conversionJobs.completeWithArtifacts({
      jobId: stale.id, ownerUserId: 'alice', executionId: 'execution_atomic_outputs',
      expectedEpoch: 1, endedAt: 30,
      artifacts: [{ ...artifacts[0]!, id: 'artifact_stale', conversionJobId: stale.id, relativePath: 'results/artifact_stale.png' }],
    })).toBeNull()
    expect(database.conversionArtifacts.listForJob(stale.id, 'alice')).toEqual([])

    const failing = createJob(database, 'job_failed_outputs', 'execution_atomic_outputs', 3, 'verifying')
    expect(() => database.conversionJobs.completeWithArtifacts({
      jobId: failing.id, ownerUserId: 'alice', executionId: 'execution_atomic_outputs',
      expectedEpoch: 0, endedAt: 40,
      artifacts: [
        { ...artifacts[0]!, id: 'artifact_duplicate', conversionJobId: failing.id, relativePath: 'results/duplicate-1.png' },
        { ...artifacts[1]!, id: 'artifact_duplicate', conversionJobId: failing.id, relativePath: 'results/duplicate-2.png' },
      ],
    })).toThrow()
    expect(database.conversionJobs.getOwned(failing.id, 'alice')).toMatchObject({ status: 'verifying', epoch: 0 })
    expect(database.conversionArtifacts.listForJob(failing.id, 'alice')).toEqual([])
    database.close()
  })

  it('fails closed for cross-user jobs and artifacts', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_alice')
    createExecution(database, 'execution_bob', 'bob')
    const job = createJob(database, 'job_alice', 'execution_alice', 1)

    expect(database.conversionJobs.getOwned(job.id, 'bob')).toBeNull()
    expect(database.conversionJobs.listForExecution('execution_alice', 'bob')).toEqual([])
    expect(() => database.conversionJobs.create({
      id: 'job_bob_for_alice_execution', ownerUserId: 'bob', executionId: 'execution_alice',
      sourceKind: 'media', sourceId: 'source_bob', targetFormat: 'png', status: 'queued', createdAt: 2,
    })).toThrow('Conversion execution ownership mismatch')

    const artifact = database.conversionArtifacts.create({
      id: 'artifact_alice', ownerUserId: 'alice', executionId: 'execution_alice',
      conversionJobId: job.id, role: 'output', displayName: 'result.png', detectedFormat: 'png',
      mimeType: 'image/png', byteSize: 12, sha256: 'a'.repeat(64),
      relativePath: 'artifacts/result.png', createdAt: 3,
    })
    expect(database.conversionArtifacts.getOwned(artifact.id, 'bob')).toBeNull()
    expect(database.conversionArtifacts.listForJob(job.id, 'bob')).toEqual([])
    expect(database.conversionArtifacts.markDeleted(artifact.id, 'bob', artifact)).toBe(false)
    expect(database.conversionArtifacts.getOwned(artifact.id, 'alice')?.status).toBe('ready')
    database.close()
  })

  it('marks deleted only when the complete ready artifact identity still matches', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_artifact_delete_cas')
    const job = createJob(database, 'job_artifact_delete_cas', 'execution_artifact_delete_cas', 1)
    const artifact = database.conversionArtifacts.create({
      id: 'artifact_delete_cas', ownerUserId: 'alice', executionId: 'execution_artifact_delete_cas',
      conversionJobId: job.id, role: 'output', displayName: 'result.png', detectedFormat: 'png',
      mimeType: 'image/png', byteSize: 12, sha256: 'a'.repeat(64),
      relativePath: 'artifacts/result.png', createdAt: 3,
    })

    expect(database.conversionArtifacts.markDeleted(artifact.id, 'alice', {
      ...artifact,
      sha256: 'b'.repeat(64),
    })).toBe(false)
    expect(database.conversionArtifacts.getOwned(artifact.id, 'alice')).toMatchObject({ status: 'ready' })
    expect(database.conversionArtifacts.markDeleted(artifact.id, 'alice', artifact)).toBe(true)
    expect(database.conversionArtifacts.getOwned(artifact.id, 'alice')).toMatchObject({ status: 'deleted' })
    database.close()
  })

  it('claims each queued job once in creation order', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_claim')
    createJob(database, 'job_later', 'execution_claim', 2)
    createJob(database, 'job_first', 'execution_claim', 1)

    expect(database.conversionJobs.claimNext('alice')).toMatchObject({
      id: 'job_first', status: 'downloading_component', epoch: 0,
    })
    expect(database.conversionJobs.claimNext('alice')).toMatchObject({ id: 'job_later' })
    expect(database.conversionJobs.claimNext('alice')).toBeNull()
    database.close()
  })

  it('uses status and epoch compare-and-set without regressing a terminal job', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_transition')
    createJob(database, 'job_transition', 'execution_transition', 1)
    const claimed = database.conversionJobs.claimNext('alice')!

    expect(database.conversionJobs.transition({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 1,
      expectedStatuses: ['downloading_component'], patch: { status: 'converting' },
    })).toBe(false)
    expect(database.conversionJobs.transition({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0,
      expectedStatuses: ['queued'], patch: { status: 'converting' },
    })).toBe(false)
    expect(database.conversionJobs.transition({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0,
      expectedStatuses: ['downloading_component'], patch: { status: 'completed', endedAt: 10 },
    })).toBe(true)
    expect(database.conversionJobs.transition({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0,
      expectedStatuses: ['completed'], patch: { status: 'queued' },
    })).toBe(false)
    expect(database.conversionJobs.getOwned(claimed.id, 'alice')).toMatchObject({
      status: 'completed', endedAt: 10,
    })
    database.close()
  })

  it('retries an eligible terminal job in a new epoch and rejects stale or invalid retries', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_retry')
    createJob(database, 'job_retry', 'execution_retry', 1)
    const claimed = database.conversionJobs.claimNext('alice')!
    expect(database.conversionJobs.transition({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0,
      expectedStatuses: ['downloading_component'],
      patch: { status: 'failed', progress: 75, errorCode: 'CONVERSION_TIMEOUT', endedAt: 10 },
    })).toBe(true)

    expect(database.conversionJobs.retry({
      jobId: claimed.id, ownerUserId: 'bob', expectedEpoch: 0, expectedStatuses: ['failed'],
    })).toBe(false)
    expect(database.conversionJobs.retry({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 1, expectedStatuses: ['failed'],
    })).toBe(false)
    expect(database.conversionJobs.retry({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0, expectedStatuses: ['completed'],
    })).toBe(false)
    expect(database.conversionJobs.retry({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0, expectedStatuses: ['failed'],
    })).toBe(true)
    expect(database.conversionJobs.getOwned(claimed.id, 'alice')).toMatchObject({
      status: 'queued', epoch: 1, progress: 0,
    })
    expect(database.conversionJobs.getOwned(claimed.id, 'alice')).not.toMatchObject({
      errorCode: expect.anything(), startedAt: expect.anything(), endedAt: expect.anything(),
    })
    expect(database.conversionJobs.transition({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0,
      expectedStatuses: ['queued'], patch: { status: 'converting' },
    })).toBe(false)
    database.close()
  })

  it('interrupts only in-flight jobs during restart recovery', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_recovery')
    createJob(database, 'job_downloading', 'execution_recovery', 1, 'downloading_component')
    createJob(database, 'job_converting', 'execution_recovery', 2, 'converting')
    createJob(database, 'job_verifying', 'execution_recovery', 3, 'verifying')
    createJob(database, 'job_queued', 'execution_recovery', 4)

    expect(database.conversionJobs.interruptInFlight('alice')).toBe(3)
    expect(database.conversionJobs.getOwned('job_downloading', 'alice')).toMatchObject({
      status: 'interrupted', errorCode: 'CONVERSION_INTERRUPTED',
    })
    expect(database.conversionJobs.getOwned('job_converting', 'alice')).toMatchObject({ status: 'interrupted' })
    expect(database.conversionJobs.getOwned('job_verifying', 'alice')).toMatchObject({ status: 'interrupted' })
    expect(database.conversionJobs.getOwned('job_queued', 'alice')).toMatchObject({ status: 'queued' })
    database.close()
  })

  it('interrupts a completed job only through the artifact-recovery compare-and-set', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_artifact_recovery')
    createJob(database, 'job_artifact_recovery', 'execution_artifact_recovery', 1)
    const claimed = database.conversionJobs.claimNext('alice')!
    expect(database.conversionJobs.transition({
      jobId: claimed.id, ownerUserId: 'alice', expectedEpoch: 0,
      expectedStatuses: ['downloading_component'],
      patch: { status: 'completed', progress: 100, endedAt: 10 },
    })).toBe(true)

    expect(database.conversionJobs.interruptCompletedForArtifactRecovery({
      jobId: 'job_artifact_recovery', ownerUserId: 'bob', expectedEpoch: 0,
    })).toBe(false)
    expect(database.conversionJobs.interruptCompletedForArtifactRecovery({
      jobId: 'job_artifact_recovery', ownerUserId: 'alice', expectedEpoch: 1,
    })).toBe(false)
    expect(database.conversionJobs.interruptCompletedForArtifactRecovery({
      jobId: 'job_artifact_recovery', ownerUserId: 'alice', expectedEpoch: 0,
    })).toBe(true)
    expect(database.conversionJobs.getOwned('job_artifact_recovery', 'alice')).toMatchObject({
      status: 'interrupted', errorCode: 'CONVERSION_INTERRUPTED',
    })
    expect(database.conversionJobs.interruptCompletedForArtifactRecovery({
      jobId: 'job_artifact_recovery', ownerUserId: 'alice', expectedEpoch: 0,
    })).toBe(false)
    database.close()
  })

  it('applies the conversion migration with the owner queue index', () => {
    const { database, path } = openTestDatabase()
    expect(database.schemaVersion()).toBe(18)
    database.close()

    const sqlite = new Database(path, { readonly: true })
    const indexes = sqlite.prepare("PRAGMA index_list('conversion_jobs')").all() as Array<{ name: string }>
    expect(indexes.map(({ name }) => name)).toContain('conversion_jobs_owner_status_created_at_idx')
    sqlite.close()
  })

  it('accepts only bounded conversion metadata and non-rooted repository paths', () => {
    const { database } = openTestDatabase()
    createExecution(database, 'execution_metadata')
    const job = createJob(database, 'job_metadata', 'execution_metadata', 1)
    expect(database.conversionArtifacts.create({
      id: 'artifact_metadata', ownerUserId: 'alice', executionId: 'execution_metadata',
      conversionJobId: job.id, role: 'output', displayName: 'result.png', detectedFormat: 'png',
      mimeType: 'image/png', byteSize: 12, sha256: 'b'.repeat(64), relativePath: 'artifacts/result.png',
      metadata: {
        iconRepresentations: [16, 32, 48], pdfPage: 1, frameSelection: 'first', transparentPadding: true,
      },
    }).metadata).toEqual({
      iconRepresentations: [16, 32, 48], pdfPage: 1, frameSelection: 'first', transparentPadding: true,
    })
    expect(() => database.conversionArtifacts.create({
      id: 'artifact_metadata_extra', ownerUserId: 'alice', executionId: 'execution_metadata',
      conversionJobId: job.id, role: 'output', displayName: 'result.png', detectedFormat: 'png',
      mimeType: 'image/png', byteSize: 12, sha256: 'c'.repeat(64), relativePath: 'artifacts/extra.png',
      metadata: { providerEvidence: 'private' } as never,
    })).toThrow('Invalid conversion artifact metadata')
    for (const relativePath of ['/tmp/result.png', 'C:\\result.png', '\\rooted\\result.png', '\\\\server\\share\\result.png']) {
      expect(() => database.conversionArtifacts.create({
        id: `artifact_${relativePath.length}`, ownerUserId: 'alice', executionId: 'execution_metadata',
        conversionJobId: job.id, role: 'output', displayName: 'result.png', detectedFormat: 'png',
        mimeType: 'image/png', byteSize: 12, sha256: 'd'.repeat(64), relativePath,
      })).toThrow('Invalid conversion artifact path')
    }
    database.close()
  })

  it('persists every scale-specific ICNS representation without collapsing equal pixel sizes', () => {
    const { database, path } = openTestDatabase()
    createExecution(database, 'execution_icns_metadata')
    const job = createJob(database, 'job_icns_metadata', 'execution_icns_metadata', 1)
    const slots = [
      { sourceType: 'icp4', logicalWidth: 16, logicalHeight: 16, pixelWidth: 16, pixelHeight: 16, scale: 1 },
      { sourceType: 'ic11', logicalWidth: 16, logicalHeight: 16, pixelWidth: 32, pixelHeight: 32, scale: 2 },
      { sourceType: 'icp5', logicalWidth: 32, logicalHeight: 32, pixelWidth: 32, pixelHeight: 32, scale: 1 },
      { sourceType: 'ic12', logicalWidth: 32, logicalHeight: 32, pixelWidth: 64, pixelHeight: 64, scale: 2 },
      { sourceType: 'ic07', logicalWidth: 128, logicalHeight: 128, pixelWidth: 128, pixelHeight: 128, scale: 1 },
      { sourceType: 'ic13', logicalWidth: 128, logicalHeight: 128, pixelWidth: 256, pixelHeight: 256, scale: 2 },
      { sourceType: 'ic08', logicalWidth: 256, logicalHeight: 256, pixelWidth: 256, pixelHeight: 256, scale: 1 },
      { sourceType: 'ic14', logicalWidth: 256, logicalHeight: 256, pixelWidth: 512, pixelHeight: 512, scale: 2 },
      { sourceType: 'ic09', logicalWidth: 512, logicalHeight: 512, pixelWidth: 512, pixelHeight: 512, scale: 1 },
      { sourceType: 'ic10', logicalWidth: 512, logicalHeight: 512, pixelWidth: 1024, pixelHeight: 1024, scale: 2 },
    ] as const
    for (const [index, iconRepresentation] of slots.entries()) {
      database.conversionArtifacts.create({
        id: `artifact_icns_${index}`, ownerUserId: 'alice', executionId: 'execution_icns_metadata',
        conversionJobId: job.id, role: 'output', displayName: `representation-${index + 1}.png`,
        detectedFormat: 'png', mimeType: 'image/png', byteSize: 12,
        sha256: String(index).padStart(64, '0'), relativePath: `artifacts/representation-${index + 1}.png`,
        metadata: { iconRepresentation },
      })
    }
    database.close()

    const reopened = openAppDatabase(path)
    expect(reopened.conversionArtifacts.listForJob(job.id, 'alice').map((artifact) => artifact.metadata))
      .toEqual(slots.map((iconRepresentation) => ({ iconRepresentation })))
    expect(reopened.conversionArtifacts.listForJob(job.id, 'alice')[1]?.metadata)
      .not.toEqual(reopened.conversionArtifacts.listForJob(job.id, 'alice')[2]?.metadata)
    reopened.close()
  })

  it('persists ordered ICO representation dimensions and original source indexes', () => {
    const { database, path } = openTestDatabase()
    createExecution(database, 'execution_ico_metadata')
    const job = createJob(database, 'job_ico_metadata', 'execution_ico_metadata', 1)
    const representations = [
      { sourceType: 'ico', sourceIndex: 1, logicalWidth: 16, logicalHeight: 16, pixelWidth: 16, pixelHeight: 16, scale: 1 },
      { sourceType: 'ico', sourceIndex: 2, logicalWidth: 32, logicalHeight: 32, pixelWidth: 32, pixelHeight: 32, scale: 1 },
      { sourceType: 'ico', sourceIndex: 4, logicalWidth: 16, logicalHeight: 16, pixelWidth: 16, pixelHeight: 16, scale: 1 },
    ] as const
    for (const [index, iconRepresentation] of representations.entries()) {
      database.conversionArtifacts.create({
        id: `artifact_ico_${index}`, ownerUserId: 'alice', executionId: 'execution_ico_metadata',
        conversionJobId: job.id, role: 'output', displayName: `icon-${iconRepresentation.pixelWidth}.png`,
        detectedFormat: 'png', mimeType: 'image/png', byteSize: 12,
        sha256: String(index).padStart(64, '0'), relativePath: `artifacts/ico-${index}.png`,
        metadata: { iconRepresentation },
      })
    }
    database.close()

    const reopened = openAppDatabase(path)
    expect(reopened.conversionArtifacts.listForJob(job.id, 'alice').map((artifact) => artifact.metadata))
      .toEqual(representations.map((iconRepresentation) => ({ iconRepresentation })))
    reopened.close()
  })

  it('enforces non-rooted artifact paths in the migration', () => {
    const { database, path } = openTestDatabase()
    createExecution(database, 'execution_path_check')
    database.close()

    const sqlite = new Database(path)
    const insert = sqlite.prepare(`
      INSERT INTO conversion_artifacts (
        id, owner_user_id, execution_id, role, display_name, detected_format,
        mime_type, byte_size, sha256, relative_path, status, created_at, updated_at
      ) VALUES (@id, 'alice', 'execution_path_check', 'output', 'result.png', 'png', 'image/png', 1, @sha256, @relativePath, 'ready', 1, 1)
    `)
    for (const [index, relativePath] of ['/tmp/result.png', 'C:\\result.png', '\\rooted\\result.png', '\\\\server\\share\\result.png'].entries()) {
      expect(() => insert.run({ id: `raw_path_${index}`, sha256: 'e'.repeat(64), relativePath }))
        .toThrow(/CHECK constraint/)
    }
    sqlite.close()
  })
})
