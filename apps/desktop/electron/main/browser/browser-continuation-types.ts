import type { BrowserPermissionMatrix } from '../workflows/workflow-security-fingerprint.js'

export interface BrowserContinuationPolicy {
  readonly auth?: {
    readonly loginUrls?: readonly string[]
    readonly loggedIn?: readonly string[]
    readonly loggedOut?: readonly string[]
  }
  readonly readableRegions?: readonly string[]
  readonly manualActions?: readonly {
    readonly locator: string
    readonly reason: string
  }[]
}

export interface BrowserContinuationProvenance {
  readonly userId: string
  readonly conversationId: string
  readonly chatRunId: string
  readonly executionId: string
  readonly workflowId: string
  readonly workflowVersion: string
  readonly source: 'installed' | 'development'
  readonly buildHash?: string
  readonly securityFingerprint: string
  readonly permissionMatrix: BrowserPermissionMatrix
  readonly browserContinuation?: BrowserContinuationPolicy
}

export interface BrowserContinuationBindingInput extends BrowserContinuationProvenance {
  readonly tabId: string
}

export interface BrowserContinuationBinding extends BrowserContinuationProvenance {
  readonly bindingId: string
  readonly tabId: string
  readonly createdAt: number
  readonly status: 'active'
}

export interface BrowserContinuationLease {
  readonly binding: BrowserContinuationBinding
  readonly ownerRunId: string
  isCurrent(binding: BrowserContinuationBinding): boolean
  release(): Promise<void>
}

export interface BrowserSemanticNode {
  readonly ref: string
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly enabled: boolean
  readonly checked?: boolean
  readonly selected?: boolean
  readonly actions: readonly ('fill' | 'select' | 'click' | 'check' | 'scroll')[]
}

export interface BrowserPageSnapshot {
  readonly snapshotId: string
  readonly bindingId: string
  readonly origin: string
  readonly url: string
  readonly title: string
  readonly capturedAt: string
  readonly navigationEpoch: number
  readonly auth: 'authenticated' | 'required' | 'unknown'
  readonly nodes: readonly BrowserSemanticNode[]
  readonly cursor?: string
  readonly serializedBytes: number
}

export interface BrowserRegionImage {
  readonly snapshotId: string
  readonly bindingId: string
  readonly origin: string
  readonly ref: string
  readonly capturedAt: string
  readonly mediaType: 'image/png'
  readonly width: number
  readonly height: number
  readonly data: string
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen)
  }
  return Object.freeze(value)
}

export function frozenBrowserContinuationProvenance(
  input: BrowserContinuationProvenance,
): BrowserContinuationProvenance {
  return deepFreeze(structuredClone(input))
}
