import { randomUUID } from 'node:crypto'
import { toSafeAppError, type AppError, type AppErrorCode } from '@autoforge/shared'
import type { BrowserTabBinding } from '../database/repositories.js'
import { canonicalJson } from '../workflows/workflow-security-fingerprint.js'
import {
  frozenBrowserContinuationProvenance,
  type BrowserContinuationBinding,
  type BrowserContinuationBindingInput,
  type BrowserContinuationLease,
} from './browser-continuation-types.js'

export interface BrowserContinuationBindingRepository {
  insert(value: BrowserTabBinding): BrowserTabBinding
  terminate(
    id: string,
    value: {
      status: 'revoked' | 'closed'
      terminalReason: AppErrorCode
      endedAt: number
    },
  ): BrowserTabBinding | undefined
}

export interface BrowserContinuationRegistryWorkspace {
  acquireContinuation(tabId: string, runId: string): Promise<void>
  releaseContinuation(tabId: string, runId: string): Promise<void>
  closeContinuation(tabId: string): Promise<void>
}

export interface BrowserContinuationRegistryOptions {
  repository: BrowserContinuationBindingRepository
  workspace: BrowserContinuationRegistryWorkspace
  id?: () => string
  now?: () => number
}

function failure(code: AppErrorCode): AppError {
  return toSafeAppError({ code })
}

function reuseIdentity(binding: BrowserContinuationBinding | BrowserContinuationBindingInput): string {
  return canonicalJson({
    userId: binding.userId,
    conversationId: binding.conversationId,
    workflowId: binding.workflowId,
    workflowVersion: binding.workflowVersion,
    source: binding.source,
    buildHash: binding.buildHash,
    securityFingerprint: binding.securityFingerprint,
    permissionMatrix: binding.permissionMatrix,
    browserContinuation: binding.browserContinuation,
  })
}

export class BrowserContinuationRegistry {
  private readonly bindings = new Map<string, BrowserContinuationBinding>()
  private readonly bindingsByTab = new Map<string, BrowserContinuationBinding>()
  private readonly leaseOwners = new Map<string, string>()
  private readonly id: () => string
  private readonly now: () => number
  private stopped = false

  constructor(private readonly options: BrowserContinuationRegistryOptions) {
    this.id = options.id ?? randomUUID
    this.now = options.now ?? Date.now
  }

  bind(input: BrowserContinuationBindingInput): BrowserContinuationBinding {
    if (this.stopped) throw failure('CONFLICT')
    const provenance = frozenBrowserContinuationProvenance(input)
    const existing = this.bindingsByTab.get(input.tabId)
    if (existing) {
      if (reuseIdentity(existing) !== reuseIdentity(input)) throw failure('CONFLICT')
      return existing
    }
    const binding = Object.freeze({
      ...provenance,
      bindingId: this.id(),
      tabId: input.tabId,
      createdAt: this.now(),
      status: 'active' as const,
    })
    this.options.repository.insert({
      id: binding.bindingId,
      tabId: binding.tabId,
      userId: binding.userId,
      conversationId: binding.conversationId,
      chatRunId: binding.chatRunId,
      executionId: binding.executionId,
      workflowId: binding.workflowId,
      workflowVersion: binding.workflowVersion,
      source: binding.source,
      ...(binding.buildHash === undefined ? {} : { buildHash: binding.buildHash }),
      securityFingerprint: binding.securityFingerprint,
      permissionMatrix: structuredClone(binding.permissionMatrix) as BrowserTabBinding['permissionMatrix'],
      status: 'active',
      createdAt: binding.createdAt,
    })
    this.bindings.set(binding.bindingId, binding)
    this.bindingsByTab.set(binding.tabId, binding)
    return binding
  }

  bindPopup(parentTabId: string, tabId: string): BrowserContinuationBinding {
    const parent = this.bindingsByTab.get(parentTabId)
    if (!parent) throw failure('PAGE_CLOSED')
    return this.bind({
      tabId,
      userId: parent.userId,
      conversationId: parent.conversationId,
      chatRunId: parent.chatRunId,
      executionId: parent.executionId,
      workflowId: parent.workflowId,
      workflowVersion: parent.workflowVersion,
      source: parent.source,
      ...(parent.buildHash === undefined ? {} : { buildHash: parent.buildHash }),
      securityFingerprint: parent.securityFingerprint,
      permissionMatrix: parent.permissionMatrix,
      ...(parent.browserContinuation === undefined ? {} : { browserContinuation: parent.browserContinuation }),
    })
  }

  list(userId: string, conversationId: string): readonly BrowserContinuationBinding[] {
    return Object.freeze([...this.bindings.values()].filter((binding) => (
      binding.userId === userId && binding.conversationId === conversationId
    )))
  }

  async acquire(
    bindingId: string,
    input: { userId: string; conversationId: string; runId: string },
  ): Promise<BrowserContinuationLease> {
    if (this.stopped) throw failure('PAGE_CLOSED')
    const binding = this.bindings.get(bindingId)
    if (!binding) throw failure('PAGE_CLOSED')
    if (binding.userId !== input.userId || binding.conversationId !== input.conversationId) {
      throw failure('NO_BOUND_PAGE')
    }
    if (this.leaseOwners.has(bindingId)) throw failure('PAGE_BUSY')
    await this.options.workspace.acquireContinuation(binding.tabId, input.runId)
    if (this.bindings.get(bindingId) !== binding || this.stopped) {
      await this.options.workspace.releaseContinuation(binding.tabId, input.runId)
      throw failure('PAGE_CLOSED')
    }
    this.leaseOwners.set(bindingId, input.runId)
    let released = false
    return Object.freeze({
      binding,
      ownerRunId: input.runId,
      release: async () => {
        if (released) return
        released = true
        if (this.leaseOwners.get(bindingId) !== input.runId) return
        this.leaseOwners.delete(bindingId)
        await this.options.workspace.releaseContinuation(binding.tabId, input.runId)
      },
    })
  }

  markClosed(tabId: string, reason: AppErrorCode): void {
    const binding = this.bindingsByTab.get(tabId)
    if (!binding) return
    const ownerRunId = this.leaseOwners.get(binding.bindingId)
    this.removeLive(binding)
    if (ownerRunId) {
      void this.options.workspace.releaseContinuation(binding.tabId, ownerRunId).catch(() => undefined)
    }
    this.options.repository.terminate(binding.bindingId, {
      status: 'closed', terminalReason: reason, endedAt: this.now(),
    })
  }

  markTakenOver(tabId: string, runId: string): void {
    const binding = this.bindingsByTab.get(tabId)
    if (binding && this.leaseOwners.get(binding.bindingId) === runId) {
      this.leaseOwners.delete(binding.bindingId)
    }
  }

  revokeConversation(conversationId: string, reason: AppErrorCode): Promise<void> {
    return this.revokeWhere((binding) => binding.conversationId === conversationId, reason)
  }

  revokeUser(userId: string, reason: AppErrorCode): Promise<void> {
    return this.revokeWhere((binding) => binding.userId === userId, reason)
  }

  async revokeBinding(bindingId: string, reason: AppErrorCode): Promise<void> {
    const binding = this.bindings.get(bindingId)
    if (!binding) return
    const ownerRunId = this.leaseOwners.get(bindingId)
    this.removeLive(binding)
    const failures: unknown[] = []
    try {
      this.options.repository.terminate(binding.bindingId, {
        status: 'revoked', terminalReason: reason, endedAt: this.now(),
      })
    } catch (error) {
      failures.push(error)
    }
    if (ownerRunId) {
      await this.options.workspace.releaseContinuation(binding.tabId, ownerRunId).catch(() => undefined)
    }
    try {
      await this.options.workspace.closeContinuation(binding.tabId)
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0) throw failures[0]
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    await this.revokeWhere(() => true, 'CANCELLED')
  }

  private removeLive(binding: BrowserContinuationBinding): void {
    this.bindings.delete(binding.bindingId)
    this.bindingsByTab.delete(binding.tabId)
    this.leaseOwners.delete(binding.bindingId)
  }

  private async revokeWhere(
    predicate: (binding: BrowserContinuationBinding) => boolean,
    reason: AppErrorCode,
  ): Promise<void> {
    const results = await Promise.allSettled(
      [...this.bindings.values()].filter(predicate)
        .map((binding) => this.revokeBinding(binding.bindingId, reason)),
    )
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}
