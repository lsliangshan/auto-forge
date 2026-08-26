import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SafeStoragePort } from '../security/secret-store.js'
import { runLocalKnowledgeReleaseHarness } from './release-harness.js'

const directories: string[] = []
const safeStorage: SafeStoragePort = {
  isAvailable: async () => true,
  encrypt: async value => Buffer.from(value),
  decrypt: async value => ({ value: value.toString(), shouldReEncrypt: false }),
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('runs the payload-free local security, retrieval, grounding, processing, and performance harness', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'autoforge-release-harness-'))
  directories.push(rootDirectory)

  const report = await runLocalKnowledgeReleaseHarness({ rootDirectory, safeStorage })

  expect(report.fixtureClass).toBe('synthetic_local')
  expect(report.officialAcceptanceEligible).toBe(false)
  expect(report.security).toEqual({
    encryptedArtifactPlaintextMatches: 0,
    crossUserLeakCount: 0,
  })
  expect(report.retrieval).toMatchObject({
    caseCount: 20,
    expectedCount: 20,
    recalledCount: 20,
    recallAt8: 1,
  })
  expect(report.grounding).toMatchObject({
    citationSupportRate: 1,
    groundedAnswerRate: 1,
    correctNoEvidenceRate: 1,
  })
  expect(report.processing).toMatchObject({
    supportedCount: 5,
    readyCount: 5,
    successRate: 1,
  })
  expect(report.performance).toMatchObject({ chunkCount: 10_000, sampleCount: 40 })
  expect(report.performance.localFtsP95Ms).toBeLessThanOrEqual(300)

  const serialized = JSON.stringify(report)
  for (const forbidden of ['"query":', '"snippet":', '"text":', '"filename":', '"path":', '"sentinel":']) {
    expect(serialized.toLowerCase()).not.toContain(forbidden)
  }
  process.stdout.write(`knowledge-release-harness:${serialized}\n`)
})
