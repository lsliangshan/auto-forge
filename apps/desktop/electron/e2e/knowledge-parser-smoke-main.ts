import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  powerSaveBlocker,
  session,
} from 'electron'
import { DEFAULT_PARSER_LIMITS } from '../main/knowledge/parser-protocol.js'
import {
  ParserFailure,
  ParserSupervisor,
  type ParserRendererDependencies,
} from '../main/knowledge/parser-supervisor.js'

const HANDLE = '0123456789abcdef0123456789abcdef'
let stage = 'start'

async function run(): Promise<void> {
  stage = 'app-ready'
  await app.whenReady()
  const blocker = powerSaveBlocker.start('prevent-app-suspension')
  stage = 'supervisor-create'
  const applicationRoot = process.env.AUTOFORGE_PARSER_APP_ROOT ?? app.getAppPath()
  const supervisor = new ParserSupervisor({
    workerHtmlPath: join(applicationRoot, 'out/renderer/electron/knowledge-parser/index.html'),
    preloadPath: join(applicationRoot, 'out/preload/knowledgeParser.cjs'),
    resolveObject: async (objectHandle) => {
      if (objectHandle !== HANDLE) throw new Error('Unexpected parser object handle')
      return Buffer.from('packaged sandbox parser', 'utf8')
    },
    partitionId: () => `autoforge-parser-smoke-${randomUUID()}`,
    processMemoryBytes: () => 1,
    createSession: partition => session.fromPartition(partition, { cache: false }) as unknown as ReturnType<ParserRendererDependencies['createSession']>,
    createMessageChannel: () => new MessageChannelMain() as unknown as ReturnType<ParserRendererDependencies['createMessageChannel']>,
    createWindow: (options) => {
      const window = new BrowserWindow(options)
      window.webContents.on('preload-error', () => console.error('Parser smoke event: preload-error'))
      window.webContents.on('did-fail-load', () => console.error('Parser smoke event: did-fail-load'))
      window.webContents.on('did-finish-load', () => console.error('Parser smoke event: did-finish-load'))
      window.webContents.on('console-message', () => console.error('Parser smoke event: renderer-console'))
      return window as unknown as ReturnType<ParserRendererDependencies['createWindow']>
    },
  })
  const key = Buffer.alloc(32, 23)
  try {
    stage = 'parse'
    const document = await supervisor.parse({
      objectHandle: HANDLE,
      oneTimeKey: key,
      mediaType: 'text/plain',
      limits: { ...DEFAULT_PARSER_LIMITS, timeoutMs: 60_000 },
    })
    stage = 'result-check'
    if (document.text !== 'packaged sandbox parser') throw new Error('Unexpected parser result')
    if (!key.every(byte => byte === 0)) throw new Error('One-time key was not cleared')
    const markerPath = process.env.AUTOFORGE_PARSER_SMOKE_MARKER
    if (!markerPath) throw new Error('Parser smoke marker is unavailable')
    writeFileSync(markerPath, 'packaged-sandbox-parser-verified', { mode: 0o600 })
  } finally {
    await supervisor.terminateAll()
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
  }
}

void run().then(
  () => {
    console.error('Packaged sandbox parser verified under Electron 43')
    setTimeout(() => app.exit(0), 50)
  },
  (error: unknown) => {
    const code = error instanceof ParserFailure ? error.code : 'UNEXPECTED'
    console.error(`Packaged sandbox parser failed at ${stage}: ${code}`)
    setTimeout(() => app.exit(1), 50)
  },
)
