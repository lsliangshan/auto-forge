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
    expect(database.conversionArtifacts.markDeleted(artifact.id, 'bob')).toBe(false)
    expect(database.conversionArtifacts.getOwned(artifact.id, 'alice')?.status).toBe('ready')
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

  it('applies the conversion migration with the owner queue index', () => {
    const { database, path } = openTestDatabase()
    expect(database.schemaVersion()).toBe(16)
    database.close()

    const sqlite = new Database(path, { readonly: true })
    const indexes = sqlite.prepare("PRAGMA index_list('conversion_jobs')").all() as Array<{ name: string }>
    expect(indexes.map(({ name }) => name)).toContain('conversion_jobs_owner_status_created_at_idx')
    sqlite.close()
  })
})
