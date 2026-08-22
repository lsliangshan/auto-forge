import { describe, expect, it } from 'vitest'
import type { ModelStreamEvent } from '../chat/model-provider.js'
import {
  APPROVAL_EXPIRY_MS,
  MAX_AGENT_ACTIVE_MS,
  WorkflowToolLoop,
} from './workflow-tool-loop.js'

function mutableClock() {
  let milliseconds = 0
  return {
    now: () => milliseconds,
    advance(delta: number) { milliseconds += delta },
  }
}

const callA: Extract<ModelStreamEvent, { type: 'tool_call' }> = {
  type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_a', name: 'workflow_1',
  arguments: { input: { query: 'first' } },
}
const callB: Extract<ModelStreamEvent, { type: 'tool_call' }> = {
  type: 'tool_call', choiceIndex: 0, index: 1, id: 'call_b', name: 'workflow_2',
  arguments: { input: { query: 'second' } },
}

describe('WorkflowToolLoop', () => {
  it('allows five starts, ten decisions, and one multi-call repair', () => {
    const clock = mutableClock()
    const loop = new WorkflowToolLoop({ now: clock.now })

    expect(loop.acceptToolCalls([callA, callB])).toEqual({ kind: 'repair' })
    expect(loop.acceptToolCalls([callA, callB])).toEqual({
      kind: 'failed', code: 'INVALID_TOOL_SEQUENCE',
    })
    for (let index = 1; index <= 5; index += 1) {
      expect(loop.startExecution(`candidate_${index}`, false, { value: index })).toEqual({
        kind: 'started', executionIndex: index,
      })
    }
    expect(loop.canOfferTools()).toBe(false)
    expect(loop.startExecution('candidate_6', false, {})).toEqual({
      kind: 'failed', code: 'TOOL_CALL_LIMIT',
    })

    for (let index = 1; index <= 10; index += 1) {
      expect(loop.beginDecision()).toEqual({ kind: 'decision', decisionIndex: index })
    }
    expect(loop.beginDecision()).toEqual({ kind: 'failed', code: 'TOOL_CALL_LIMIT' })
  })

  it('allows one changed-input read-only retry only after a failed start', () => {
    const loop = new WorkflowToolLoop({ now: () => 0 })
    const first = loop.startExecution('candidate', true, { b: 2, a: 1 })
    expect(first).toEqual({ kind: 'started', executionIndex: 1 })

    expect(loop.startExecution('candidate', true, { a: 1, b: 2 })).toEqual({
      kind: 'failed', code: 'INVALID_TOOL_SEQUENCE',
    })
    loop.finishExecution(1, 'failed')
    expect(loop.executionEligibility('candidate', true, { a: 1, b: 3 })).toEqual({ kind: 'eligible' })
    expect(loop.startExecution('candidate', true, { a: 1, b: 2 })).toEqual({
      kind: 'failed', code: 'INVALID_TOOL_SEQUENCE',
    })
    expect(loop.startExecution('candidate', true, { a: 1, b: 3 })).toEqual({
      kind: 'started', executionIndex: 2,
    })
    loop.finishExecution(2, 'failed')
    expect(loop.startExecution('candidate', true, { a: 1, b: 4 })).toEqual({
      kind: 'failed', code: 'INVALID_TOOL_SEQUENCE',
    })
  })

  it('never retries a successful, external-action, or sensitive-read candidate', () => {
    const completed = new WorkflowToolLoop({ now: () => 0 })
    expect(completed.startExecution('read', true, { page: 1 })).toMatchObject({ kind: 'started' })
    completed.finishExecution(1, 'completed')
    expect(completed.startExecution('read', true, { page: 2 })).toEqual({
      kind: 'failed', code: 'INVALID_TOOL_SEQUENCE',
    })

    for (const candidate of ['external', 'sensitive']) {
      const loop = new WorkflowToolLoop({ now: () => 0 })
      expect(loop.startExecution(candidate, false, { value: 1 })).toMatchObject({ kind: 'started' })
      loop.finishExecution(1, 'failed')
      expect(loop.executionEligibility(candidate, false, { value: 2 })).toEqual({
        kind: 'failed', code: 'INVALID_TOOL_SEQUENCE',
      })
      expect(loop.startExecution(candidate, false, { value: 2 })).toEqual({
        kind: 'failed', code: 'INVALID_TOOL_SEQUENCE',
      })
    }
  })

  it('pauses active time during approval and expires approval at thirty minutes', () => {
    const clock = mutableClock()
    const loop = new WorkflowToolLoop({ now: clock.now })
    clock.advance(60_000)
    loop.awaitApproval()
    expect(loop.awaitingApproval()).toBe(true)
    clock.advance(APPROVAL_EXPIRY_MS - 60_000)
    expect(loop.approvalExpired()).toBe(false)
    clock.advance(60_001)
    expect(loop.approvalExpired()).toBe(true)
    expect(loop.activeElapsedMs()).toBe(60_000)
    expect(loop.resumeApproval()).toEqual({ kind: 'failed', code: 'CANCELLED' })
  })

  it('checks the ten-minute active budget before provider decisions and starts', () => {
    const decisionClock = mutableClock()
    const decisionLoop = new WorkflowToolLoop({ now: decisionClock.now })
    decisionClock.advance(MAX_AGENT_ACTIVE_MS)
    expect(decisionLoop.beginDecision()).toEqual({
      kind: 'failed', code: 'MODEL_PROVIDER_TIMEOUT',
    })

    const startClock = mutableClock()
    const startLoop = new WorkflowToolLoop({ now: startClock.now })
    startClock.advance(MAX_AGENT_ACTIVE_MS)
    expect(startLoop.startExecution('candidate', true, {})).toEqual({
      kind: 'failed', code: 'MODEL_PROVIDER_TIMEOUT',
    })
  })
})
