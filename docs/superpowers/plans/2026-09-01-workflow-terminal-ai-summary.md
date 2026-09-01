# Workflow Terminal AI Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent-owned file-conversion workflows wait for real terminal conversion results, then let the configured model write one final response, while removing the redundant workflow-provenance card from new and historical chat messages.

**Architecture:** `ExecutionService` will force Agent-authorized `file.convert` requests through its existing foreground terminal-wait path while preserving manual developer background behavior. `AgentOrchestrator` will consume the trusted `startReserved(...).finished` result and run its normal post-tool model turn without appending provenance. `MessageBlock` will suppress legacy persisted provenance blocks at the render boundary without changing the shared schema.

**Tech Stack:** TypeScript 6, Electron main process, Vue 3, Pinia, Vitest, pnpm monorepo

**Spec:** `docs/superpowers/specs/2026-09-01-workflow-terminal-ai-summary-design.md`

## Global Constraints

- New responses must not contain a `workflow_provenance` block; old persisted blocks remain parseable but invisible.
- Workflow status, approval, conversion, execution details, logs, and Inspector data must remain available.
- Agent-owned file conversions must wait for terminal status even when `background` is omitted or `true`.
- Manual developer executions without `agentAuthorization` must retain immediate queued receipts for omitted or `true` background mode.
- The closing model request must happen only after `startReserved(...).finished` resolves with the trusted terminal execution snapshot.
- Multi-attachment and partial-failure results must produce exactly one closing model response after all items settle.
- User cancellation must remain terminal and must not start another model request.
- Do not add polling, database tables, background continuation records, or post-finalization message mutation.
- Do not change the shared `ChatBlock` schema or remove persisted provenance data.
- The separate global “始终允许” permission feature is out of scope.
- Preserve unrelated dirty-worktree changes and stage only files named by the current task.
- Before each task, record `git diff -- <task files>`; if a target file already contains unrelated hunks, do not stage or commit the whole file. Leave that task's verified changes uncommitted and report why instead of capturing user work in a feature commit.
- Do not run headed browser or Playwright tests.

---

### Task 1: Force Agent-owned conversions through the existing terminal wait

**Files:**
- Modify: `apps/desktop/electron/main/workflows/execution-service.ts:1373-1471`
- Test: `apps/desktop/electron/main/workflows/execution-service.test.ts:320-353`
- Test: `apps/desktop/electron/main/workflows/execution-service.test.ts:1141-1235`

**Interfaces:**
- Consumes: `ActiveExecution.agentAuthorization?: AgentExecutionAuthorization`, `ActiveExecution.fileConvertAuthorization?: FileConvertAuthorization`, and `FileConversionPort.waitForTerminal(jobId, ownerUserId, signal)`.
- Produces: unchanged capability result shapes: `{ accepted: true, status: 'queued', outputs: [] }`, `{ accepted: true, status: 'completed', outputs }`, or `{ accepted: false, status: 'failed', error }`.
- Invariant for later tasks: an Agent-owned conversion execution cannot finish with a final queued receipt solely because the workflow requested background mode.

- [ ] **Step 1: Extend the conversion test input helper with an explicit Agent marker**

Add an `agentAuthorized?: boolean` option to `conversionStartInput` and project the same authorization shape used by `WorkflowToolExecutor`:

```ts
function conversionStartInput(
  executionId: string,
  sourceSelector: ReturnType<ReturnType<typeof createWorkflowSourceSelectorVault>['create']>,
  bindings: readonly ExecutionAttachmentBinding[] = [attachmentBinding()],
  options: {
    authorize?: boolean
    agentAuthorized?: boolean
    formats?: readonly ConversionTargetFormat[]
    authorizationFingerprint?: string
  } = {},
): Parameters<ExecutionService['startReserved']>[1] {
  return {
    userId: 'user_1',
    conversationId: 'conversation_1',
    workflowId: conversionWorkflow.id,
    workflowVersion: conversionWorkflow.version,
    input: { files: [0], targetFormat: 'png' },
    sourceSelector,
    attachmentBindings: bindings,
    ...(options.agentAuthorized ? {
      agentAuthorization: {
        workflowFingerprint: workflowSecurityFingerprint(conversionWorkflow),
        permissions: conversionWorkflow.permissions.map((permission, permissionIndex) => ({
          permissionIndex,
          capability: permission.capability,
          scope: permission.scope,
          scopeHash: scopeHash(permission.scope),
        })),
      },
    } : {}),
    ...(options.authorize === false ? {} : {
      fileConvertAuthorization: {
        executionId,
        capability: 'file.convert',
        decision: 'once',
        attachments: bindings.map((binding) => ({
          index: binding.attachmentIndex,
          sourceFingerprint: options.authorizationFingerprint ?? binding.sourceFingerprint,
        })),
        formats: options.formats ?? ['png'],
      },
    }),
  }
}
```

- [ ] **Step 2: Write failing tests for forced foreground and preserved manual background behavior**

Keep the existing manual `it.each([undefined, true])` queued-receipt test, and add this Agent-owned case immediately before it:

```ts
it.each([undefined, true])(
  'waits for an Agent-authorized conversion terminal result when background is %s',
  async (background) => {
    let releaseTerminal!: (value: FileConversionTerminalResult) => void
    const terminal = new Promise<FileConversionTerminalResult>((resolve) => {
      releaseTerminal = resolve
    })
    const conversion = createFileConversionPort({
      waitForTerminal: async () => terminal,
    })
    const harness = createHarness({
      conversion,
      source: {
        workflow: conversionWorkflow,
        rootPath: trustedRootPath,
        entryPath: 'workers/workflow-runner.ts',
        integrity: 'valid',
      },
    })
    const reservation = harness.service.reserve()
    const execution = await harness.service.startReserved(
      reservation,
      conversionStartInput(
        reservation.executionId,
        harness.sourceSelector,
        [attachmentBinding()],
        { agentAuthorized: true },
      ),
    )
    const worker = harness.workerFactory.workers.get(execution.id)!
    worker.respond({ type: 'ready', executionId: execution.id })
    worker.respond({
      type: 'capability_request',
      requestId: 'convert_agent_terminal',
      request: conversionRequest({ ...(background === undefined ? {} : { background }) }),
    })

    await vi.waitFor(() => expect(conversion.waitForTerminal).toHaveBeenCalledOnce())
    expect(worker.requests).not.toContainEqual(expect.objectContaining({
      type: 'capability_result',
      requestId: 'convert_agent_terminal',
    }))

    releaseTerminal({
      status: 'completed',
      outputs: [{ displayName: 'result.png', detectedFormat: 'png', byteSize: 64 }],
    })
    await vi.waitFor(() => expect(worker.requests).toContainEqual({
      type: 'capability_result',
      requestId: 'convert_agent_terminal',
      result: {
        accepted: true,
        status: 'completed',
        outputs: [{ name: 'converted-1-1.png', format: 'png', byteSize: 64 }],
      },
    }))
    worker.respond({ type: 'result', output: { converted: true } })
    await expect(execution.finished).resolves.toMatchObject({ status: 'completed' })
  },
)
```

Import `FileConversionTerminalResult` from `execution-service.ts` in the existing type-only import.

- [ ] **Step 3: Run the focused execution-service test and confirm the new assertion fails**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/workflows/execution-service.test.ts --config vitest.node.config.ts
```

Expected: the new Agent-owned test fails because `waitForTerminal` is not called when `background` is omitted or `true`; the existing manual queued tests pass.

- [ ] **Step 4: Make the foreground decision depend on Agent ownership**

Replace the background early-return condition in `dispatchFileConversion` with:

```ts
const mustWaitForTerminal = active.agentAuthorization !== undefined || background === false
if (!mustWaitForTerminal) {
  return { accepted: true, status: 'queued', outputs: [] }
}
```

Leave submission validation, attachment authorization, foreground tracking, abort handling, terminal validation, and safe output projection unchanged.

- [ ] **Step 5: Run the execution-service tests and verify both ownership paths**

Run the same focused command from Step 3.

Expected: PASS. The new Agent-owned cases call `waitForTerminal`; the existing manual omitted/`true` cases still return queued without waiting; existing explicit `background: false`, cancellation, timeout, and terminal-error tests remain green.

- [ ] **Step 6: Commit only the execution-service change**

```bash
git add apps/desktop/electron/main/workflows/execution-service.ts apps/desktop/electron/main/workflows/execution-service.test.ts
git commit -m "fix: wait for agent conversion completion"
```

---

### Task 2: Stop emitting workflow provenance blocks

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:1560-1760`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:2260-2480`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:3225-3240`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:3460-3510`
- Test: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: the existing `actualExecutions` collection for routing and execution bookkeeping.
- Produces: terminal assistant `blocks` containing workflow status, result-specific cards, text, and errors, but never a newly appended `workflow_provenance` block.
- Compatibility: the shared provenance block type and existing persisted records are untouched.

- [ ] **Step 1: Change provenance-positive Agent tests into absence assertions**

Update every Agent-orchestrator expectation that currently requires the final block to be provenance. The assertion at the end of each affected test must instead inspect the full terminal block list:

```ts
const finalBlocks = (dependencies.records.terminal.at(-1) as { blocks: unknown[] }).blocks
expect(finalBlocks).not.toContainEqual(expect.objectContaining({
  type: 'workflow_provenance',
}))
```

For tests that previously used provenance to verify execution status or identity, assert the authoritative workflow status block instead:

```ts
expect(finalBlocks).toContainEqual(expect.objectContaining({
  type: 'workflow_status',
  executionId: 'reserved_1',
  status: 'completed',
}))
```

Retain existing assertions for error codes, final text, browser behavior, execution count, workflow source, build hash, and city; do not weaken those behaviors merely to remove the card.

- [ ] **Step 2: Run Agent tests and confirm provenance-positive cases fail**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/agent-orchestrator.test.ts --config vitest.node.config.ts
```

Expected: the converted absence assertions fail because current terminal messages still append `workflow_provenance`.

- [ ] **Step 3: Remove every provenance append path and its private helper**

Delete calls to `this.appendWorkflowProvenance(active)` from:

- the knowledge-consent terminal response;
- normal `finishReason === 'stop'` completion;
- early grounded browser answers;
- knowledge-consent fence terminalization;
- the temporary conversion-card completion shortcut, which Task 3 removes completely.

Then delete this method:

```ts
private appendWorkflowProvenance(active: ActiveAgentRun): void {
  if (active.actualExecutions.length === 0) return
  this.appendBlock(active, {
    type: 'workflow_provenance',
    blockId: this.id(),
    entries: active.actualExecutions.map((entry) => structuredClone(entry)),
  })
}
```

Keep `actualExecutions` and its entry type because routing logic still uses `actualExecutions.length` and workflow completion still records actual execution status.

- [ ] **Step 4: Run Agent tests and verify new responses contain no provenance**

Run the focused command from Step 2.

Expected: provenance absence assertions pass, and workflow status, error, knowledge, browser, and final-text tests remain green except the conversion shortcut test intentionally changed in Task 3.

- [ ] **Step 5: Commit only provenance emission removal**

```bash
git add apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "fix: remove workflow provenance responses"
```

---

### Task 3: Restore one model closing turn after the trusted terminal result

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:2425-2475`
- Test: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts:3154-3212`

**Interfaces:**
- Consumes: `StartedExecution.finished: Promise<Execution>` and `WorkflowToolExecutor.toModelResult(...)`.
- Produces: one sanitized tool message followed by exactly one configured-model closing turn for completed or failed executions; cancelled executions continue to terminalize without another model request.
- Relies on Task 1: Agent-owned conversions do not resolve `finished` with a transient final queued receipt.

- [ ] **Step 1: Replace the stale-queued shortcut regression with terminal-result assertions**

Rename the existing test to `waits for a conversion terminal result and asks the model for one closing response`. Use a deferred execution completion and make the second provider turn return a valid closing text:

```ts
it('waits for a conversion terminal result and asks the model for one closing response', async () => {
  const dependencies = harness([[
    {
      type: 'tool_call', choiceIndex: 0, index: 0, id: 'call_convert_status', name: 'workflow_1',
      arguments: { input: { files: [0, 1], targetFormat: 'pdf' } },
    },
    { type: 'finish', choiceIndex: 0, reason: 'tool_calls' },
  ], [
    { type: 'text_delta', choiceIndex: 0, text: '两个附件均已转换完成。' },
    { type: 'finish', choiceIndex: 0, reason: 'stop' },
  ]])
  dependencies.workflows.list = async () => [conversionWorkflow]
  const terminal = deferred<Execution>()
  dependencies.executions.startReserved = async (reservation, input) => {
    dependencies.records.starts.push({ ...input, executionId: reservation.executionId })
    return { id: reservation.executionId, finished: terminal.promise }
  }
  const orchestrator = new AgentOrchestrator(dependencies)
  const firstAttachment = currentConversionAttachments()[0]!
  const attachments = [
    firstAttachment,
    {
      ...firstAttachment,
      attachmentIndex: 1,
      displayName: 'second.png',
      source: { kind: 'media' as const, mediaAssetId: 'media_private_1' },
      sourceFingerprint: 'c'.repeat(64),
    },
  ]
  const pending = await orchestrator.run(protectedAttachmentRunInput({
    ...textRunInput({
      conversationId: 'conversion_conversation', content: '将附件转换成 PDF',
      provider: 'openrouter', model: 'model',
    }),
    assetIds: ['media_private_0', 'media_private_1'],
    attachmentBindings: attachments,
  }))

  const resultPromise = orchestrator.resumeApproval({
    executionId: pending.executionId!,
    permissionIndex: 0,
    scopeHash: scopeHash(conversionWorkflow.permissions[0]!.scope),
    decision: 'once',
  })
  await vi.waitFor(() => expect(dependencies.records.starts).toHaveLength(1))
  expect(orchestrator.onConversionJobSubmitted(pending.executionId!)).toBe(true)
  expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledTimes(1)

  terminal.resolve({
    id: pending.executionId!,
    workflowId: conversionWorkflow.id,
    workflowVersion: conversionWorkflow.version,
    status: 'completed',
    input: { files: [0, 1], targetFormat: 'pdf' },
    result: {
      workflow: '万象转换',
      results: [
        { accepted: true, status: 'completed', outputs: [{ name: 'converted-1-1.pdf', format: 'pdf', byteSize: 100 }] },
        { accepted: true, status: 'completed', outputs: [{ name: 'converted-2-1.pdf', format: 'pdf', byteSize: 200 }] },
      ],
    },
    createdAt: 1,
  })

  await expect(resultPromise).resolves.toMatchObject({ status: 'completed' })
  expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledTimes(2)
  const closingRequest = vi.mocked(dependencies.providerInstances.openrouter.stream).mock.calls[1]![0]
  expect(closingRequest.messages).toContainEqual(expect.objectContaining({
    role: 'tool',
    content: expect.stringContaining('"status":"completed"'),
  }))
  expect(JSON.stringify(closingRequest)).not.toMatch(/"status":"queued"|排队/u)
  const finalBlocks = (dependencies.records.terminal.at(-1) as { blocks: unknown[] }).blocks
  expect(finalBlocks).toContainEqual(expect.objectContaining({
    type: 'text', text: '两个附件均已转换完成。',
  }))
  expect(finalBlocks).not.toContainEqual(expect.objectContaining({ type: 'workflow_provenance' }))
})
```

- [ ] **Step 2: Add a mixed-result test for one summary after every item settles**

Add a sibling test whose terminal workflow result contains one completed item and one failed item:

```ts
result: {
  workflow: '万象转换',
  results: [
    { accepted: true, status: 'completed', outputs: [{ name: 'converted-1-1.pdf', format: 'pdf', byteSize: 100 }] },
    { accepted: false, status: 'failed', error: { code: 'CONVERSION_FAILED', message: 'File conversion failed.' } },
  ],
}
```

The provider’s second turn must return `已完成 1 个附件，另有 1 个转换失败。`. Assert:

```ts
expect(dependencies.providerInstances.openrouter.stream).toHaveBeenCalledTimes(2)
expect(JSON.stringify(closingRequest.messages)).toContain('"status":"completed"')
expect(JSON.stringify(closingRequest.messages)).toContain('"status":"failed"')
expect(finalBlocks.filter((block) => (
  typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
))).toHaveLength(1)
```

- [ ] **Step 3: Run the focused Agent tests and confirm the old shortcut fails the new contract**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/agent-orchestrator.test.ts --config vitest.node.config.ts
```

Expected: the new tests fail because a conversion card currently terminalizes the run after the first provider call.

- [ ] **Step 4: Delete the conversion-card early terminalization branch**

Remove `hasAuthoritativeConversionBlock` and this entire branch:

```ts
if (terminalStatus === 'completed' && hasAuthoritativeConversionBlock) {
  return this.terminalize(active, 'completed')
}
```

The tail of `continuePendingTool` must remain:

```ts
this.updateWorkflowStatus(active, pending, terminalStatus, statusError)
this.appendToolExchange(active, pending, modelResult)
this.clearPending(active)
this.enableKnowledgeAfterWorkflow(active)
if (terminalStatus === 'completed') await this.refreshBrowserCatalog(active)
return this.drive(active)
```

This reuses the normal model decision path; do not introduce a special summary provider call or a polling loop.

- [ ] **Step 5: Re-run Agent tests and verify completion, failure, and cancellation behavior**

Run the focused command from Step 3.

Expected: PASS. Completed and mixed-result conversions make exactly two provider calls total; closing requests contain sanitized terminal tool results; existing cancellation tests still make no post-cancel provider call.

- [ ] **Step 6: Commit only terminal AI continuation changes**

```bash
git add apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "fix: summarize terminal workflow results"
```

---

### Task 4: Hide legacy persisted provenance without an empty wrapper

**Files:**
- Modify: `apps/desktop/src/components/chat/MessageBlock.vue:1-55`
- Test: `apps/desktop/tests/components/chat.test.ts:1829-1910`

**Interfaces:**
- Consumes: `UiChatBlock`, which intentionally still includes the legacy `workflow_provenance` variant.
- Produces: no DOM nodes for that variant; all other block variants continue rendering through their existing branches.
- Compatibility: `WorkflowProvenance.vue` and the shared schema are not deleted in this task because existing data must remain readable and unrelated user edits to that component must be preserved.

- [ ] **Step 1: Replace provenance-card rendering tests with one legacy suppression test**

Remove the tests that expect compact, logo, and multi-entry provenance cards. Add:

```ts
it('renders no DOM wrapper for a historical workflow provenance block', () => {
  const wrapper = mount(MessageBlock, {
    props: { block: workflowProvenanceBlock([{
      executionId: 'execution_1',
      workflowId: 'workflow.beijing',
      workflowName: '北京工作居住证',
      workflowVersion: '1.0.0',
      source: 'installed',
      city: '北京',
      status: 'completed',
    }]) },
    global: { plugins: [ElementPlus] },
  })

  expect(wrapper.find('.message-block').exists()).toBe(false)
  expect(wrapper.find('[data-testid="workflow-provenance"]').exists()).toBe(false)
  expect(wrapper.text()).toBe('')
  expect(wrapper.text()).not.toContain('已使用工作流')
})
```

Keep the store test that merges historical provenance updates by Main-owned block ID; it validates backward-compatible ingestion rather than presentation.

- [ ] **Step 2: Run the component test and verify the old card is still visible**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run tests/components/chat.test.ts --config vitest.config.ts
```

Expected: the new legacy suppression test fails because `WorkflowProvenance` currently renders inside `.message-block`.

- [ ] **Step 3: Suppress provenance at the component root**

Change the template root and remove the provenance child branch:

```vue
<template>
  <div
    v-if="block.type !== 'workflow_provenance'"
    class="message-block"
  >
    <!-- all existing non-provenance branches remain unchanged -->
  </div>
</template>
```

Delete:

```vue
<WorkflowProvenance
  v-else-if="block.type === 'workflow_provenance'"
  :block="block"
/>
```

and remove:

```ts
import WorkflowProvenance from './WorkflowProvenance.vue'
```

Do not change `UiChatBlock`, persisted message parsing, live-event merging, or shared contracts.

- [ ] **Step 4: Run component tests and renderer type checking**

Run:

```bash
pnpm --filter @autoforge/desktop exec vitest run tests/components/chat.test.ts --config vitest.config.ts
pnpm --filter @autoforge/desktop typecheck
```

Expected: PASS. Historical provenance mounts to an empty component root with no `.message-block`; workflow status, approval, conversion, execution, text, error, media, browser, and knowledge block tests remain green.

- [ ] **Step 5: Commit only renderer suppression changes**

```bash
git add apps/desktop/src/components/chat/MessageBlock.vue apps/desktop/tests/components/chat.test.ts
git commit -m "fix: hide legacy workflow provenance cards"
```

---

### Task 5: Update application and integration contracts for terminal AI output

**Files:**
- Modify: `apps/desktop/electron/main/application.test.ts:4280-4450`
- Modify: `apps/desktop/electron/main/application.test.ts:13148-13345`
- Modify: `apps/desktop/tests/integration/agent-workflow.test.ts:380-445`
- Modify: `apps/desktop/tests/integration/agent-workflow.test.ts:560-620`
- Modify: `apps/desktop/tests/integration/agent-workflow.test.ts:620-790`
- Modify: `apps/desktop/tests/integration/agent-workflow.test.ts:850-890`

**Interfaces:**
- Consumes: Task 1 terminal-wait behavior, Task 2 no-provenance persistence, Task 3 normal closing model turn, and existing conversion block coordination.
- Produces: integration evidence that status/result cards and final AI text coexist in order, multi-attachment terminal data reaches one closing request, and no provenance block is emitted.

- [ ] **Step 1: Rewrite application provenance assertions around retained authoritative UI**

In installed/development workflow application tests, replace waits for `workflow_provenance` with waits for the terminal `workflow_status` and closing text:

```ts
await vi.waitFor(() => expect(app.chatEvents).toContainEqual(expect.objectContaining({
  type: 'block',
  block: expect.objectContaining({
    type: 'workflow_status',
    executionId: pending.approval.executionId,
    status: 'completed',
  }),
})))
await vi.waitFor(() => expect(JSON.stringify(app.chatEvents)).toContain('工作流处理完成'))
expect(app.chatEvents).not.toContainEqual(expect.objectContaining({
  type: 'block',
  block: expect.objectContaining({ type: 'workflow_provenance' }),
}))
```

Keep exact installed/development source, build hash, city, and execution ID checks on the approval and workflow status blocks.

- [ ] **Step 2: Strengthen the fast-conversion application regression**

After resolving the execution completion, assert all three externally visible facts:

```ts
await vi.waitFor(() => expect(chatEvents).toContainEqual(expect.objectContaining({
  type: 'block_update',
  block: expect.objectContaining({
    type: 'conversion', executionId: approval.executionId, state: 'terminal',
  }),
})))
await vi.waitFor(() => expect(chatEvents).toContainEqual(expect.objectContaining({
  type: 'block',
  block: { type: 'text', text: '转换任务已完成' },
})))
expect(chatEvents).not.toContainEqual(expect.objectContaining({
  type: 'block', block: expect.objectContaining({ type: 'workflow_provenance' }),
}))
```

Also assert the provider saw exactly one Agent tool-selection request and one post-tool closing request, excluding the separate conversation-title request by reusing the test’s `isConversationTitleRequest` predicate:

```ts
const agentRequests = vi.mocked(provider.stream).mock.calls
  .map(([request]) => request)
  .filter((request) => !isConversationTitleRequest(request))
expect(agentRequests).toHaveLength(2)
expect(agentRequests[1]!.messages).toContainEqual(expect.objectContaining({
  role: 'tool',
  content: expect.not.stringContaining('"status":"queued"'),
}))
```

- [ ] **Step 3: Update integration tests that used provenance as their final assertion**

For single and multiple workflow runs, preserve execution ordering and identity assertions on database execution records, then assert:

```ts
expect(assistant.blocks).toContainEqual(expect.objectContaining({
  type: 'text',
  text: expect.any(String),
}))
expect(assistant.blocks).toContainEqual(expect.objectContaining({
  type: 'workflow_status',
  status: 'completed',
}))
expect(assistant.blocks).not.toContainEqual(expect.objectContaining({
  type: 'workflow_provenance',
}))
```

Tests for direct answers must continue to assert that neither workflow status nor provenance exists.

- [ ] **Step 4: Strengthen the multi-attachment conversion integration assertion**

In `runs one exact multi-attachment conversion while the Provider sees canonical fields only`, change the final model text from `本地转换已提交` to a terminal statement such as `两个附件转换处理完毕。`. In the second provider request, assert the tool content includes both terminal item results and contains no final queued status:

First make the fake Worker's trusted terminal output represent both settled attachments:

```ts
workerOutput: (request) => ({
  workflow: '万象转换',
  results: (request.input as { files: number[] }).files.map((attachmentIndex) => ({
    accepted: true,
    status: 'completed',
    outputs: [{
      name: `converted-${attachmentIndex + 1}-1.pdf`,
      format: 'pdf',
      byteSize: attachmentIndex === 0 ? 67 : 4_096,
    }],
  })),
}),
```

Then assert the second request consumes that trusted output:

```ts
expect(body.messages).toEqual(expect.arrayContaining([
  expect.objectContaining({
    role: 'tool',
    tool_call_id: 'tool_convert_pdf',
    content: expect.stringContaining('"status":"completed"'),
  }),
]))
expect(JSON.stringify(body.messages)).not.toContain('"status":"queued"')
```

After completion, assert exactly two Agent provider bodies, one final text block, terminal workflow status, and no provenance. Keep all existing canonical-field and private-path leakage assertions.

- [ ] **Step 5: Run application and integration tests and address only contract-related failures**

Run:

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/application.test.ts --config vitest.node.config.ts
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run tests/integration/agent-workflow.test.ts --config vitest.node.config.ts
```

Expected: PASS. If an unrelated pre-existing failure remains, record its exact test name and output without changing unrelated production code.

- [ ] **Step 6: Commit integration contract updates**

```bash
git add apps/desktop/electron/main/application.test.ts apps/desktop/tests/integration/agent-workflow.test.ts
git commit -m "test: cover terminal workflow AI summaries"
```

---

### Task 6: Run final static and regression verification

**Files:**
- Verify only; no planned production changes.

**Interfaces:**
- Consumes: all preceding task deliverables.
- Produces: evidence that targeted behavior, full desktop typing, lint, and production build remain valid.

- [ ] **Step 1: Run the targeted regression set together**

```bash
pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/workflows/execution-service.test.ts electron/main/agent/agent-orchestrator.test.ts electron/main/application.test.ts tests/integration/agent-workflow.test.ts --config vitest.node.config.ts
pnpm --filter @autoforge/desktop exec vitest run tests/components/chat.test.ts --config vitest.config.ts
```

Expected: all targeted tests pass with zero failed tests.

- [ ] **Step 2: Run repository type checking and lint**

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit with code 0. Do not apply broad auto-formatting to unrelated dirty files.

- [ ] **Step 3: Run the production build**

```bash
pnpm build
```

Expected: all package builds, desktop Electron/Vue build, and configured E2E fixture builds exit with code 0.

- [ ] **Step 4: Inspect the final scoped diff**

```bash
git diff --check
git status --short
git diff -- apps/desktop/electron/main/workflows/execution-service.ts apps/desktop/electron/main/workflows/execution-service.test.ts apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/src/components/chat/MessageBlock.vue apps/desktop/tests/components/chat.test.ts apps/desktop/electron/main/application.test.ts apps/desktop/tests/integration/agent-workflow.test.ts
```

Expected: no whitespace errors; every changed line maps to terminal waiting, final AI output, provenance suppression, or its tests; unrelated user changes remain untouched.

- [ ] **Step 5: Record the verification result without creating an empty commit**

If all implementation files were committed in Tasks 1–5, do not create a verification-only commit. Report exact passing commands and distinguish any unrelated pre-existing failure by test name and command.
