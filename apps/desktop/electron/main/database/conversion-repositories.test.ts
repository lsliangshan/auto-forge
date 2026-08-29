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
