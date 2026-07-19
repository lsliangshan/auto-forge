import { safeStorage } from 'electron'
import type { Page, SignedRelease, WorkflowSummary, CategorySummary } from '@autoforge/workflow-contracts'
import type { AuthRequest, CategoryMutation, SessionState, SessionUser, SubmissionDetail, SubmissionSummary, WorkflowQuery } from '../../shared/contracts'
import type { AppDatabase } from '../database/app-database'
import type { SettingsService } from '../settings/settings-service'

interface SessionResponse { accessToken: string; refreshToken: string; user: SessionUser }

export class RegistryClient {
  private accessToken?: string
  private user: SessionUser | null = null
  constructor(private readonly database: AppDatabase, private readonly settings: SettingsService) {
    const stored = database.getEncryptedSession()
    if (stored) try { this.user = JSON.parse(stored.userJson) as SessionUser } catch { database.clearEncryptedSession() }
  }

  getSession(): SessionState { return { user: this.user } }
  async restore(): Promise<void> { if (this.database.getEncryptedSession()) try { await this.refresh() } catch { this.clear() } }
  async login(input: AuthRequest) { return this.authenticate('/api/v1/auth/login', { email: input.email, password: input.password }) }
  async register(input: AuthRequest) { return this.authenticate('/api/v1/auth/register', { email: input.email, password: input.password, displayName: input.displayName }) }
  async logout() { const token = this.readRefresh(); if (token) await this.fetch('/api/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: token }) }, false).catch(() => undefined); this.clear() }

  listCategories() { return this.request<CategorySummary[]>('/api/v1/categories', {}, false) }
  listWorkflows(query: WorkflowQuery = {}) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value)); return this.request<Page<WorkflowSummary>>(`/api/v1/workflows?${params}`, {}, false) }
  downloadTicket(workflowId: string, version: string) { return this.request<SignedRelease>(`/api/v1/workflows/${encodeURIComponent(workflowId)}/releases/${encodeURIComponent(version)}/download-ticket`, { method: 'POST' }) }
  createWorkflow(manifest: unknown) { return this.request<{ id: string }>('/api/v1/developer/workflows', { method: 'POST', body: JSON.stringify(manifest) }) }
  async submit(workflowId: string, archive: Uint8Array, codeSha256?: string) {
    const body = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer
    const form = new FormData(); form.set('file', new Blob([body]), 'workflow.zip')
    return this.request<SubmissionSummary>(`/api/v1/developer/workflows/${workflowId}/submissions`, { method: 'POST', headers: codeSha256 ? { 'x-code-sha256': codeSha256 } : {}, body: form })
  }
  mySubmissions() { return this.request<SubmissionSummary[]>('/api/v1/developer/submissions') }
  pendingSubmissions() { return this.request<SubmissionSummary[]>('/api/v1/admin/submissions') }
  submission(id: string) { return this.request<SubmissionDetail>(`/api/v1/admin/submissions/${id}`) }
  adminCategories() { return this.request<CategorySummary[]>('/api/v1/admin/categories') }
  createCategory(input: CategoryMutation) { return this.request<CategorySummary>('/api/v1/admin/categories', { method: 'POST', body: JSON.stringify(input) }) }
  updateCategory(id: string, input: CategoryMutation) { return this.request<CategorySummary>(`/api/v1/admin/categories/${id}`, { method: 'PATCH', body: JSON.stringify(input) }) }
  async deleteCategory(id: string) { await this.request(`/api/v1/admin/categories/${id}`, { method: 'DELETE' }) }
  async approve(id: string) { await this.request(`/api/v1/admin/submissions/${id}/approve`, { method: 'POST' }) }
  async reject(id: string, comment: string) { await this.request(`/api/v1/admin/submissions/${id}/reject`, { method: 'POST', body: JSON.stringify({ comment }) }) }
  async download(url: string): Promise<Buffer> { const response = await fetch(url); if (!response.ok) throw new Error(`Download failed (${response.status})`); return Buffer.from(await response.arrayBuffer()) }

  private async authenticate(path: string, body: unknown): Promise<SessionState> { const session = await this.fetch<SessionResponse>(path, { method: 'POST', body: JSON.stringify(body) }, false); this.save(session); return this.getSession() }
  private async refresh(): Promise<void> { const refreshToken = this.readRefresh(); if (!refreshToken) throw new Error('No refresh token'); this.save(await this.fetch<SessionResponse>('/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }, false)) }
  private async request<T = unknown>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    let response = await this.fetchResponse(path, init, authenticated)
    if (authenticated && response.status === 401 && this.readRefresh()) { await this.refresh(); response = await this.fetchResponse(path, init, true) }
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: { message?: string } }; throw new Error(body.error?.message ?? `Registry request failed (${response.status})`) }
    return response.status === 204 ? undefined as T : response.json() as Promise<T>
  }
  private async fetch<T>(path: string, init: RequestInit, authenticated: boolean): Promise<T> { const response = await this.fetchResponse(path, init, authenticated); if (!response.ok) throw new Error(`Registry request failed (${response.status})`); return response.json() as Promise<T> }
  private fetchResponse(path: string, init: RequestInit, authenticated: boolean) {
    const headers = new Headers(init.headers); if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json'); if (authenticated && this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`)
    return fetch(new URL(path, this.settings.get().apiBaseUrl), { ...init, headers })
  }
  private save(session: SessionResponse) { if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable'); this.accessToken = session.accessToken; this.user = session.user; this.database.setEncryptedSession(safeStorage.encryptString(session.refreshToken).toString('base64'), JSON.stringify(session.user)) }
  private readRefresh() { const stored = this.database.getEncryptedSession(); if (!stored || !safeStorage.isEncryptionAvailable()) return undefined; try { return safeStorage.decryptString(Buffer.from(stored.encryptedRefreshToken, 'base64')) } catch { return undefined } }
  private clear() { this.accessToken = undefined; this.user = null; this.database.clearEncryptedSession() }
}
