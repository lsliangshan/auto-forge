import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { BrowserWindow, ipcMain, session, type WebContents } from 'electron'
import { hostMatches, type WorkflowManifest, type WorkflowPermission } from '@autoforge/workflow-contracts'
import type { ExecutionResult } from '../../shared/contracts'

type Capability = 'navigate' | 'waitFor' | 'exists' | 'readText' | 'readValue' | 'click' | 'fill' | 'selectOption' | 'check' | 'downloadByClick' | 'log' | 'complete' | 'failed'
const permissions: Partial<Record<Capability, WorkflowPermission>> = { navigate: 'browser.navigate', waitFor: 'browser.read', exists: 'browser.read', readText: 'browser.read', readValue: 'browser.read', click: 'browser.interact', fill: 'browser.interact', selectOption: 'browser.interact', check: 'browser.interact', downloadByClick: 'browser.download' }
interface Execution { id: string; manifest: WorkflowManifest; target: BrowserWindow; runner: BrowserWindow; timeout: NodeJS.Timeout; status: ExecutionResult['status']; cleanupPath?: string }

export class WorkflowExecutionService {
  private readonly executions = new Map<string, Execution>(); private readonly byRunner = new Map<number, string>()
  constructor(private readonly runnerRoot: string, private readonly runnerPreload: string, private readonly downloadDirectory: string) { ipcMain.handle('workflow-sdk:call', (event, payload) => this.handle(event.sender, payload)) }

  async start(entryPath: string, manifest: WorkflowManifest, targetUrl: string, cleanupPath?: string): Promise<ExecutionResult> {
    this.validateUrl(targetUrl, manifest); const id = randomUUID(); const partition = `workflow-${id}`
    const target = new BrowserWindow({ width: 1280, height: 900, title: manifest.name, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition } })
    const runnerPartition = `workflow-runner-${id}`; const runnerSession = session.fromPartition(runnerPartition)
    runnerSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
    const runner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: runnerPartition, preload: this.runnerPreload } })
    const timeout = setTimeout(() => this.stop(id, 'Workflow execution timed out'), 10 * 60 * 1000)
    const execution: Execution = { id, manifest, target, runner, timeout, status: 'RUNNING', cleanupPath }; this.executions.set(id, execution); this.byRunner.set(runner.webContents.id, id)
    target.once('closed', () => this.stop(id, 'Target window closed')); runner.once('closed', () => { if (this.executions.has(id)) this.stop(id, 'Runner window closed') })
    await target.loadURL(targetUrl)
    await runner.loadFile(join(this.runnerRoot, 'index.html'), { query: { executionId: id, entry: pathToFileURL(entryPath).href } })
    return { executionId: id, status: 'RUNNING' }
  }

  async startSource(source: string, manifest: WorkflowManifest, targetUrl: string): Promise<ExecutionResult> {
    const directory = mkdtempSync(join(tmpdir(), 'autoforge-trial-')); const result = await build({ stdin: { contents: source, sourcefile: 'src/index.ts', loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', external: ['@autoforge/workflow-sdk'] })
    const entry = join(directory, 'index.mjs'); writeFileSync(entry, result.outputFiles[0].contents)
    try { return await this.start(entry, manifest, targetUrl, directory) } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
  }

  stop(id: string, error = 'Execution stopped'): void { const execution = this.executions.get(id); if (!execution) return; execution.status = 'ABORTED'; clearTimeout(execution.timeout); this.byRunner.delete(execution.runner.webContents.id); if (!execution.runner.isDestroyed()) execution.runner.destroy(); if (!execution.target.isDestroyed()) execution.target.destroy(); if (execution.cleanupPath) rmSync(execution.cleanupPath, { recursive: true, force: true }); this.executions.delete(id) }
  close(): void { for (const id of [...this.executions.keys()]) this.stop(id) }

  private async handle(sender: WebContents, payload: unknown): Promise<unknown> {
    const input = payload as { executionId?: string; method?: Capability; args?: unknown[] }; const id = this.byRunner.get(sender.id)
    if (!id || id !== input.executionId) throw new Error('Invalid execution identity')
    const execution = this.executions.get(id); if (!execution || execution.status !== 'RUNNING') throw new Error('Execution is not active')
    const method = input.method; if (!method) throw new Error('SDK method is required'); const required = permissions[method]
    if (required && !execution.manifest.permissions.includes(required)) throw new Error(`Permission not declared: ${required}`)
    const operation = this.perform(execution, method, input.args ?? [])
    return Promise.race([operation, new Promise((_, reject) => setTimeout(() => reject(new Error('SDK operation timed out')), 15_000))])
  }

  private async perform(execution: Execution, method: Capability, args: unknown[]): Promise<unknown> {
    const [selector, value] = args; if (typeof selector === 'string' && selector.length > 500) throw new Error('Selector is too long')
    if (method === 'complete' || method === 'failed') { const result = method === 'complete' ? args[0] : undefined; const error = method === 'failed' ? String(args[0]) : undefined; clearTimeout(execution.timeout); execution.status = error ? 'FAILED' : 'COMPLETED'; this.byRunner.delete(execution.runner.webContents.id); this.executions.delete(execution.id); if (!execution.runner.isDestroyed()) execution.runner.destroy(); if (execution.cleanupPath) rmSync(execution.cleanupPath, { recursive: true, force: true }); return { result, error } }
    if (method === 'log') { console.log(JSON.stringify({ executionId: execution.id, level: args[0], message: String(args[1]).slice(0, 1000) })); return }
    if (method === 'navigate') { const url = String(args[0]); this.validateUrl(url, execution.manifest); await execution.target.loadURL(url); return }
    if (method === 'downloadByClick') {
      const downloaded = new Promise<string>((resolve, reject) => execution.target.webContents.session.once('will-download', (_event, item) => {
        const path = join(this.downloadDirectory, `${Date.now()}-${basename(item.getFilename())}`); item.setSavePath(path)
        item.once('done', (_done, state) => state === 'completed' ? resolve(path) : reject(new Error(`Download ${state}`)))
      }))
      await execution.target.webContents.executeJavaScript(this.domScript('click', String(selector), undefined, undefined), true); return downloaded
    }
    const script = this.domScript(method, String(selector), value, args[1]); return execution.target.webContents.executeJavaScript(script, true)
  }

  private domScript(method: Capability, selector: string, value: unknown, second: unknown): string {
    const s = JSON.stringify(selector); const v = JSON.stringify(value)
    if (method === 'waitFor') return `new Promise((resolve,reject)=>{const end=Date.now()+${Math.min(Number(second) || 15000,15000)};const poll=()=>document.querySelector(${s})?resolve():Date.now()>end?reject(new Error('Element not found')):setTimeout(poll,100);poll()})`
    if (method === 'exists') return `Boolean(document.querySelector(${s}))`
    if (method === 'readText') return `(()=>{const e=document.querySelector(${s});if(!e)throw new Error('Element not found');return e.textContent??''})()`
    if (method === 'readValue') return `(()=>{const e=document.querySelector(${s});if(!e||!('value' in e))throw new Error('Input not found');return e.value})()`
    if (method === 'click' || method === 'downloadByClick') return `(()=>{const e=document.querySelector(${s});if(!(e instanceof HTMLElement))throw new Error('Element not found');e.click();return true})()`
    if (method === 'fill') return `(()=>{const e=document.querySelector(${s});if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement))throw new Error('Input not found');e.value=${v};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))})()`
    if (method === 'selectOption') return `(()=>{const e=document.querySelector(${s});if(!(e instanceof HTMLSelectElement))throw new Error('Select not found');e.value=${v};e.dispatchEvent(new Event('change',{bubbles:true}))})()`
    if (method === 'check') return `(()=>{const e=document.querySelector(${s});if(!(e instanceof HTMLInputElement)||e.type!=='checkbox')throw new Error('Checkbox not found');e.checked=${value === false ? 'false' : 'true'};e.dispatchEvent(new Event('change',{bubbles:true}))})()`
    throw new Error(`Unsupported SDK method: ${method}`)
  }

  private validateUrl(value: string, manifest: WorkflowManifest) { const url = new URL(value); const local = ['localhost', '127.0.0.1'].includes(url.hostname); if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local && url.protocol === 'http:')) throw new Error('Workflow target must use HTTPS'); if (!hostMatches(url.hostname, manifest.targetHosts)) throw new Error(`Target host is not declared: ${url.hostname}`) }
}
