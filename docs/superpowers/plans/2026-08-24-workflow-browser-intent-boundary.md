# Workflow Browser Intent Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop automatic browser-route recovery after a workflow execution while preserving explicit browser calls and direct page-question recovery.

**Architecture:** `AgentOrchestrator` already records trusted, real workflow attempts in `active.actualExecutions`. Gate only the orchestrator-created route-recovery branch on that list being empty; do not change the browser tool catalog, model-authored tool-call handling, or workflow execution lifecycle.

**Tech Stack:** TypeScript 6, Vitest 4 under Electron's pinned Node ABI, existing `AgentOrchestrator` harness.

**Spec:** `docs/superpowers/specs/2026-08-24-browser-intent-and-visual-evidence-design.md`

## Global Constraints

- Work on branch `v2`; preserve unrelated user changes.
- Do not change workflow manifests, database schemas, Renderer code, or public APIs.
- The target query completes its workflow and leaves the target browser page open.
- Explicit primary-model browser calls after a workflow remain allowed.
- Direct page questions with no workflow execution retain isolated route recovery.
- Use headless/unit tests only; do not open a visible browser.
- Every production change must be preceded by a failing regression test.

---

## File Structure

- `apps/desktop/electron/main/agent/agent-orchestrator.ts`: owns the single automatic route-recovery gate.
- `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`: proves the workflow boundary, explicit-call compatibility, and direct-question recovery.

### Task 1: Prevent post-workflow automatic page inspection

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts` near the existing browser route-recovery tests around `keeps an unrelated direct answer...`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts` in the `finishReason === 'stop'` branch around the `routeBrowserContinuationRequest` call

**Interfaces:**
- Consumes: `ActiveAgentRun.actualExecutions: WorkflowProvenanceEntry[]`, populated only after `WorkflowToolExecutor.start` admits a real execution.
- Produces: no new interface; automatic route recovery is eligible only when `actualExecutions.length === 0`.

- [ ] **Step 1: Add the failing workflow-boundary regression test**

Add this test beside the current isolated browser-route tests. It deliberately leaves a route response available so the pre-fix code proves the unwanted extra call:

```ts
it('does not auto-inspect a bound page after the current run executes a workflow', async () => {
  const finalText = '已打开北京工作居住证页面。'
  const dependencies = harness([
    toolTurn,
    [
      { type: 'text_delta', choiceIndex: 0, text: finalText },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ],
    [
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'unexpected_route',
        name: 'report_browser_continuation_route', arguments: { bindingId: 'binding_1' },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ],
  ])
  dependencies.workflows.list = async () => [{
    ...workflow,
    name: '北京工作居住证',
    activationExamples: ['查询北京工作居住证'],
  }]
  dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })
  const browser = attachBrowserContinuation(dependencies)

  await expect(new AgentOrchestrator(dependencies).run(textRunInput({
    conversationId: 'browser_conversation', content: '查询北京工作居住证',
    provider: 'openrouter', model: 'model', requestId: 'workflow_open_only',
  }))).resolves.toMatchObject({ status: 'completed' })

  expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledTimes(2)
  expect(browser.executor.execute).not.toHaveBeenCalled()
  expect(JSON.stringify(dependencies.records.terminal.at(-1))).toContain(finalText)
  expect(JSON.stringify(dependencies.records.terminal.at(-1))).toContain('workflow_provenance')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  -t "does not auto-inspect a bound page after the current run executes a workflow"
```

Expected: FAIL because the provider stream is called a third time for browser-route recovery; the browser executor may also inspect the binding.

- [ ] **Step 3: Add the minimal route-recovery gate**

Change only the existing stop-branch condition:

```ts
const mayRecoverBrowserRoute = !active.browserRead
  && !active.browserTerminal
  && active.actualExecutions.length === 0
  && active.browserCatalog.bindings.size > 0

if (mayRecoverBrowserRoute) {
```

Replace only the current `if (!active.browserRead ... bindings.size > 0)` opening line with the expression above. Keep the existing `routeBrowserContinuationRequest` call and closing brace as the body of this `if`.
```

Do not gate the earlier `toolCalls.length > 0` path. That path must continue to accept an explicit `browser_session_inspect` emitted by the primary model after a workflow.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: PASS; exactly two provider turns, no browser executor call, workflow provenance retained.

- [ ] **Step 5: Add explicit-call compatibility coverage**

Add this test next to the workflow-boundary regression:

```ts
it('still honors an explicit browser inspect emitted after a workflow execution', async () => {
  const dependencies = harness([
    toolTurn,
    [
      {
        type: 'tool_call', choiceIndex: 0, index: 0, id: 'explicit_after_workflow',
        name: 'browser_session_inspect',
        arguments: { bindingId: 'binding_1', intent: '读取附件管理页面' },
      },
      { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
    ],
    [
      { type: 'text_delta', choiceIndex: 0, text: '网页已读取。' },
      { type: 'finish', choiceIndex: 0, reason: 'stop' },
    ],
  ])
  dependencies.workflows.list = async () => [{
    ...workflow,
    name: '北京工作居住证',
    activationExamples: ['运行查询并读取附件页面'],
  }]
  dependencies.policy.evaluate = () => ({ allowed: true, requiresApproval: false })
  const browser = attachBrowserContinuation(dependencies)

  await expect(new AgentOrchestrator(dependencies).run(textRunInput({
    conversationId: 'browser_conversation', content: '运行查询并读取附件页面',
    provider: 'openrouter', model: 'model', requestId: 'workflow_then_explicit_read',
  }))).resolves.toMatchObject({ status: 'completed' })

  expect(browser.executor.execute).toHaveBeenCalledWith(
    'browser_session_inspect',
    { bindingId: 'binding_1', intent: '运行查询并读取附件页面' },
    expect.any(Object),
  )
})
```

The orchestrator replaces the model-supplied inspection intent with the trusted current request; assert that exact behavior. Keep the existing `recovers a missing browser tool call through an isolated semantic route` test unchanged as the direct-page recovery proof.

- [ ] **Step 6: Run all route-boundary tests**

Run:

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  -t "auto-inspect|explicit browser inspect|isolated semantic route|unrelated direct answer"
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the independently working boundary fix**

```bash
git add apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "fix(browser): stop route recovery after workflow execution"
```

### Task 2: Verify the boundary against the complete Agent suite

**Files:**
- Verify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Verify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: the route-recovery gate from Task 1.
- Produces: a verified, standalone workflow-intent boundary that Plan 2 can build on.

- [ ] **Step 1: Run the full orchestrator test file**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/agent-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run desktop Main type checking**

```bash
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS.

- [ ] **Step 3: Check the final diff**

```bash
git diff --check HEAD~1..HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted files from this plan.
