import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { app, BrowserWindow, powerSaveBlocker } from 'electron'
import type { KnowledgeDocumentSummary, KnowledgeEvent } from '@autoforge/shared'
import type { SafeStoragePort } from '../main/security/secret-store.js'
import { KnowledgeStoreFactory, type KnowledgeStore } from '../main/knowledge/encrypted-database.js'
import { createLocalKnowledgeService } from '../main/knowledge/knowledge-service.js'
import { createElectronParserSupervisor } from '../main/knowledge/parser-supervisor.js'
import { minimalPdf } from '../main/knowledge/test-fixtures/document-fixtures.js'

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY
}

function benchmarkSafeStorage(): SafeStoragePort {
  const mask = Buffer.from('8db31f4895d7ee642127a14a1b097a20', 'hex')
  return {
    isAvailable: async () => true,
    encrypt: async value => Buffer.from(Buffer.from(value).map((byte, index) => byte ^ mask[index % mask.length]!)),
    decrypt: async value => ({
      value: Buffer.from(value.map((byte, index) => byte ^ mask[index % mask.length]!)).toString(),
      shouldReEncrypt: false,
    }),
  }
}

async function run(): Promise<void> {
  const marker = process.env.AUTOFORGE_KNOWLEDGE_BENCHMARK_MARKER
  const root = process.env.AUTOFORGE_KNOWLEDGE_BENCHMARK_ROOT
  const desktopRoot = process.env.AUTOFORGE_E2E_DESKTOP_ROOT
  if (!marker || !root || !desktopRoot) throw new Error('Knowledge benchmark environment is incomplete')
  app.setPath('userData', join(root, 'electron-profile'))
  await app.whenReady()
  const blocker = powerSaveBlocker.start('prevent-app-suspension')
  const keeper = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  await keeper.loadURL('data:text/html,<title>Knowledge benchmark harness</title>')
  const factory = new KnowledgeStoreFactory(root, benchmarkSafeStorage())
  const terminal = new Map<string, KnowledgeDocumentSummary>()
  const waiters = new Map<string, (document: KnowledgeDocumentSummary) => void>()
  let selected = 0
  let selectedBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let store: KnowledgeStore | undefined
  const onEvent = (event: KnowledgeEvent): void => {
    if (event.type !== 'document_updated' || !['ready', 'failed'].includes(event.document.status)) return
    terminal.set(event.document.id, event.document)
    waiters.get(event.document.id)?.(event.document)
    waiters.delete(event.document.id)
  }
  const waitForTerminal = (documentId: string): Promise<KnowledgeDocumentSummary> => {
    const current = terminal.get(documentId)
    if (current) return Promise.resolve(current)
    return new Promise(resolve => waiters.set(documentId, resolve))
  }
  const service = createLocalKnowledgeService({
    openStore: async ownerId => {
      store = await factory.open(ownerId)
      store.database.pragma('synchronous = FULL')
      return store
    },
    selectImportFiles: async () => [{
      name: `sandbox-100-page-${selected += 1}.pdf`,
      mimeType: 'application/pdf',
      bytes: Buffer.from(selectedBytes),
    }],
    createParser: currentStore => createElectronParserSupervisor({
      workerHtmlPath: join(desktopRoot, 'out/renderer/electron/knowledge-parser/index.html'),
      preloadPath: join(desktopRoot, 'out/preload/knowledgeParser.cjs'),
      resolveObject: objectId => currentStore.objects.read(objectId),
    }),
    saveExport: async () => undefined,
    isMember: () => true,
    emit: onEvent,
  })
  const owner = { userId: 'pdf-benchmark-owner' }
  try {
    await service.bind(owner.userId)
    const base = await service.create(owner, '真实沙箱 PDF 基准')
    const durations: number[] = []
    for (let sample = 0; sample < 10; sample += 1) {
      selectedBytes = minimalPdf(Array.from(
        { length: 100 },
        (_, page) => `Benchmark sample ${sample} page ${page + 1} durable sandbox text`,
      ))
      const start = performance.now()
      const handle = (await service.pickImportFiles(owner))[0]!
      const queued = await service.importDocument(owner, base.id, handle.id)
      if (!queued) throw new Error('PDF import did not create a durable document')
      const completed = await waitForTerminal(queued.id)
      durations.push(performance.now() - start)
      if (completed.status !== 'ready') throw new Error(`PDF did not reach ready: ${completed.status}`)
      const search = await service.searchSelected(
        owner,
        `Benchmark sample ${sample} page 100 durable sandbox text`,
        [base.id],
      )
      if (search.kind !== 'results' || !search.evidence.some(item => item.documentId === queued.id)) {
        throw new Error('Published PDF blocks were not searchable through FTS')
      }
    }
    const durable = store!.database.prepare(`
      SELECT
        (SELECT count(*) FROM knowledge_import_jobs WHERE status = 'completed') AS completedJobs,
        (SELECT count(*) FROM knowledge_blocks) AS blocks,
        (SELECT count(*) FROM kb_chunks) AS chunks,
        (SELECT count(*) FROM document_versions WHERE status = 'ready') AS readyVersions
    `).get() as { completedJobs: number; blocks: number; chunks: number; readyVersions: number }
    store!.database.pragma('wal_checkpoint(TRUNCATE)')
    const report = {
      schema: 'autoforge.knowledge-gate.v2',
      gate: 'pdf-100-pages-object-job-sandbox-ready',
      metrics: {
        p95Ms: percentile95(durations), samples: durations.length, pagesPerSample: 100,
        objectStore: 'encrypted-durable', jobStore: 'sqlite-full', parser: 'sandbox-browserwindow',
        publication: 'blocks-fts-ready', ...durable,
      },
    }
    if (report.metrics.p95Ms > 120_000 || durable.completedJobs !== 10
      || durable.readyVersions !== 10 || durable.blocks !== 1_000 || durable.chunks !== 1_000) {
      throw new Error(`Knowledge PDF benchmark failed: ${JSON.stringify(report)}`)
    }
    await writeFile(marker, JSON.stringify(report), { mode: 0o600 })
    await new Promise(resolve => setTimeout(resolve, 100))
  } finally {
    selectedBytes.fill(0)
    service.invalidate()
    await service.drain().catch(() => undefined)
    if (!keeper.isDestroyed()) keeper.destroy()
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
  }
}

void run().then(
  () => app.exit(0),
  async (error: unknown) => {
    console.error(error)
    const marker = process.env.AUTOFORGE_KNOWLEDGE_BENCHMARK_MARKER
    if (marker) await writeFile(`${marker}.error`, String(error), { mode: 0o600 })
    process.exitCode = 1
    app.exit(1)
  },
)
