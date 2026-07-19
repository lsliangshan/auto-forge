import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateManifest } from '@autoforge/workflow-schema'
import type { WorkerResponse } from '@autoforge/shared'
import workflow from './index.js'
import manifest from '../manifest.json'

function context() {
  const calls: unknown[][] = []
  return {
    calls,
    value: {
      logger: { debug() {}, info(message: string) { calls.push(['log', message]) }, warn() {}, error() {} },
      browser: {
        async open(url: string) { calls.push(['open', url]) },
        async fill(locator: string, value: string) { calls.push(['fill', locator, value]) },
        async click(locator: string) { calls.push(['click', locator]) },
        async url() { calls.push(['url']); return 'https://www.baidu.com/s?wd=test' },
        async close() { calls.push(['close']) },
      },
    },
  }
}

describe('browser.search.baidu example', () => {
  it('opens Baidu, fills the keyword, clicks the exact named button, and reads the safe URL', async () => {
    const harness = context()
    const result = await workflow.run(harness.value, { keyword: '今日天气' })
    expect(harness.calls).toEqual([
      ['log', '正在使用百度搜索：今日天气'],
      ['open', 'https://www.baidu.com'],
      ['fill', 'role=textbox', '今日天气'],
      ['click', 'role=button[name="百度一下"]'],
      ['url'],
    ])
    expect(result).toEqual({ success: true, keyword: '今日天气', url: 'https://www.baidu.com/s?wd=test' })
  })

  it.each([{}, { keyword: '' }, { keyword: 42 }])('rejects invalid input %j', async (input) => {
    await expect(workflow.run(context().value, input as never)).rejects.toThrow('keyword')
  })

  it('ships a valid least-privilege manifest and matching reproducible build hash', async () => {
    expect(validateManifest(manifest)).toEqual({ valid: true, diagnostics: [] })
    expect(manifest).toMatchObject({
      id: 'browser.search.baidu', version: '1.0.0', timeoutMs: 30_000,
      entryPath: 'dist/index.js', activationExamples: expect.any(Array), activationNegativeExamples: expect.any(Array),
    })
    expect(manifest.permissions).toEqual(['browser.open', 'browser.fill', 'browser.click', 'browser.url'].map((capability) => ({
      capability, scope: { origins: ['https://www.baidu.com'] },
    })))
    const built = await readFile(fileURLToPath(new URL('../dist/index.js', import.meta.url)))
    expect(createHash('sha256').update(built).digest('hex')).toBe(manifest.codeSha256)
  })

  it('loads in the restricted runner without network access', async () => {
    const runnerPath = fileURLToPath(new URL('../../../apps/desktop/electron/workers/workflow-runner.ts', import.meta.url))
    const entryPath = fileURLToPath(new URL('../dist/index.js', import.meta.url))
    const worker = fork(runnerPath, [], {
      env: { AUTOFORGE_EXECUTION_NONCE: 'baidu_example_test' }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: ['--experimental-vm-modules'],
    })
    const messages: WorkerResponse[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runner timed out')), 5_000)
        worker.on('error', reject)
        let buffer = ''
        worker.stdout!.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line) continue
            const message = JSON.parse(line) as WorkerResponse
            messages.push(message)
            if (message.type === 'capability_request') {
              const result = message.request.capability === 'browser.url' ? 'https://www.baidu.com/s?wd=test' : null
              worker.stdin!.write(`${JSON.stringify({ type: 'capability_result', requestId: message.requestId, result })}\n`)
            }
            if (message.type === 'result') { clearTimeout(timer); resolve() }
            if (message.type === 'error') { clearTimeout(timer); reject(message.error) }
          }
        })
        worker.stdin!.write(`${JSON.stringify({
          type: 'start', executionId: 'exec_example', workflowId: manifest.id, workflowVersion: manifest.version,
          entryPath, input: { keyword: '今日天气' },
        })}\n`)
      })
    } finally {
      worker.kill('SIGTERM')
    }
    expect(messages.filter((message) => message.type === 'capability_request').map((message) =>
      message.type === 'capability_request' ? message.request.capability : '')).toEqual([
      'browser.open', 'browser.fill', 'browser.click', 'browser.url',
    ])
    expect(messages.at(-1)).toMatchObject({ type: 'result', output: { success: true, keyword: '今日天气' } })
  })
})
