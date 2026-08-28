import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { expect, test, _electron } from '@playwright/test'

const desktopRoot = resolve(import.meta.dirname, '../..')
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'))
const electronExecutable = requireFromDesktop('electron') as string
const benchmarkMain = join(desktopRoot, '.e2e/main/knowledge-benchmark-main.js')

test('measures 100-page ready through encrypted object, durable job, sandbox parser, and FTS publication', async () => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'autoforge-knowledge-pdf-benchmark-'))
  const marker = join(root, 'benchmark.json')
  const application = await _electron.launch({
    executablePath: electronExecutable,
    args: [benchmarkMain],
    env: {
      ...process.env,
      AUTOFORGE_E2E_DESKTOP_ROOT: desktopRoot,
      AUTOFORGE_KNOWLEDGE_BENCHMARK_ROOT: join(root, 'data'),
      AUTOFORGE_KNOWLEDGE_BENCHMARK_MARKER: marker,
    },
  })
  try {
    const exitCode = await new Promise<number | null>(resolve => application.process().once('exit', resolve))
    expect(exitCode).toBe(0)
    const report = JSON.parse(await readFile(marker, 'utf8')) as {
      schema: string
      gate: string
      metrics: Record<string, number | string>
    }
    expect(report).toMatchObject({
      schema: 'autoforge.knowledge-gate.v2',
      gate: 'pdf-100-pages-object-job-sandbox-ready',
      metrics: {
        samples: 10,
        pagesPerSample: 100,
        objectStore: 'encrypted-durable',
        jobStore: 'sqlite-full',
        parser: 'sandbox-browserwindow',
        publication: 'blocks-fts-ready',
        completedJobs: 10,
        readyVersions: 10,
        blocks: 1_000,
        chunks: 1_000,
      },
    })
    expect(report.metrics.p95Ms).toBeLessThanOrEqual(120_000)
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    await application.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
