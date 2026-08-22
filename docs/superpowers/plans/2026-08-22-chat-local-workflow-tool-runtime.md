# Chat Local Workflow Tool Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the text-chat model semantically select city-applicable workflows, execute at most five exact workflow builds sequentially, and answer only after verified results return.

**Architecture:** Keep `AgentOrchestrator` as the Main-owned coordinating facade and add focused catalog, router, loop, and executor units around the existing provider, conversation-context, policy, and `ExecutionService` ports. Main remains authoritative for developer mode, exact source identity, city, schemas, permissions, result budgets, cancellation, and provenance; Renderer displays system-owned blocks only.

**Tech Stack:** TypeScript, Electron 43, Vue 3, Pinia, Zod, AJV with `ajv-formats`, Vitest through the Electron ABI 148 runner, SQLite, and the existing OpenAI-compatible streaming tool protocol.

**Spec:** `docs/superpowers/specs/2026-08-22-chat-local-workflow-tool-runtime-design.md`

## Global Constraints

- Treat the current dirty worktree as user-owned. Before execution, establish a clean baseline that includes the existing `input-validation.ts`, `application.ts`, shared-contract, developer-store, and browser-workspace changes; never discard or overwrite them.
- Use `superpowers:using-git-worktrees` before implementation once that baseline is safely committed or otherwise available to the isolated worktree.
- Text-output chat only. Image, audio, and video generation routes remain unchanged.
- Missing `cities` and `cities: []` mean all cities. Never infer location from IP, OS region, or the number of available workflows.
- Installed workflows remain eligible with developer mode off. Development builds require developer mode, `ready` state, clean fingerprints, and an exact build identity.
- At most five started workflows and ten normal tool-loop decisions per user turn; calls are sequential.
- Full tool definitions use at most 20 percent of the model input budget; semantic routing returns at most 20 ordered candidates.
- Agent active time is ten minutes; approval wait pauses that budget and expires after 30 minutes.
- A model-visible result uses at most 25 percent of the current model input budget and at most 256 KiB, whichever is smaller.
- Side-effect and sensitive-read workflows never retry automatically. A read-only workflow may retry once only with materially changed arguments.
- Keep Renderer untrusted, Preload narrow, secrets and policy in Main, workflows in the existing restricted Worker, and remote browser content outside the app IPC bridge.
- Do not add geolocation, a city database, automatic chat-time builds, unsupported Worker capabilities, marketplace behavior, or unrelated refactors.
- Build every changed shared package before root typecheck so workspace consumers do not read stale `dist` output.

## Baseline Prerequisite

The implementation depends on the semantic developer input validator currently present as user-owned work at `apps/desktop/electron/main/workflows/input-validation.ts`. Before Task 1, verify that file and its callers are part of the implementation branch baseline:

```bash
git status --short
git log -1 --oneline
test -f apps/desktop/electron/main/workflows/input-validation.ts
rg -n "validateWorkflowInput" apps/desktop/electron/main/workflows/input-validation.ts apps/desktop/electron/main/application.ts
```

Expected: the validator exists, `application.ts` calls it for `developer.run`, and no user-owned change is removed to create the implementation worktree.

## File Structure

### New focused units

- `apps/desktop/electron/main/agent/workflow-catalog.ts` — immutable candidates, city wrapper, exact tool-name mapping.
- `apps/desktop/electron/main/agent/workflow-router.ts` — 20-percent budget and same-model semantic shortlist.
- `apps/desktop/electron/main/agent/workflow-tool-loop.ts` — execution/decision limits, repair, retry, timing, expiry.
- `apps/desktop/electron/main/agent/workflow-tool-executor.ts` — city/input/identity/permission preflight and result budget.
- `apps/desktop/electron/main/agent/capability-risk.ts` — host-owned capability classification.
- `apps/desktop/electron/main/workflows/output-validation.ts` — AJV output validation.
- `apps/desktop/electron/main/workflows/workflow-source-selector.ts` — opaque exact source selector vault.
- `apps/desktop/src/components/chat/WorkflowStatusCard.vue` — sequential status and execution link.
- `apps/desktop/src/components/chat/WorkflowProvenance.vue` — final workflow/city/status disclosure.
- Create colocated `.test.ts` files for every new Main unit.

### Existing focused changes

- Shared: `packages/shared/src/desktop-api.ts`, `events.ts`, `errors.ts`, `contracts.test.ts`.
- Main: Registry, project service, execution service, Agent orchestrator, conversation context, application, and their tests.
- Renderer: chat/developer stores, message/approval/editor components, and component tests.
- Integration: `apps/desktop/tests/integration/agent-workflow.test.ts`.

---

### Task 1: Extend strict shared contracts and safe errors

**Files:**
- Modify: `packages/shared/src/desktop-api.ts:364-389`
- Modify: `packages/shared/src/events.ts:38-104`
- Modify: `packages/shared/src/errors.ts:3-93`
- Modify: `packages/shared/src/contracts.test.ts:360-410,818-950`

**Interfaces:**
- Consumes: existing `WorkflowDetail`, `ChatBlock`, `ExecutionStatus`, `AppErrorCode`, and approval schemas.
- Produces: `WorkflowRuntimeIdentity`, `WorkflowChatAvailability`, `workflow_status` and `workflow_provenance` blocks, bound chat-approval fields, and the seven spec error codes.

- [ ] **Step 1: Add failing strict-contract tests**

```ts
const validWorkflowDetail = {
  id: 'workflow.example', version: '1.0.0', name: '示例工作流', description: '示例',
  author: 'AutoForge', category: 'test', enabled: true, source: 'installed' as const,
  integrity: 'valid' as const, updatedAt: '2026-08-22T00:00:00.000Z', cities: [],
  runtimeIdentity: { id: 'workflow.example', version: '1.0.0', source: 'installed' as const },
  permissions: [], activationExamples: [], activationNegativeExamples: [], timeoutMs: 30_000,
  inputSchema: {}, outputSchema: {},
}

it('requires normalized cities and exact runtime identity', () => {
  expect(workflowDetailSchema.parse({
    ...validWorkflowDetail,
    cities: ['北京'],
    runtimeIdentity: {
      id: validWorkflowDetail.id,
      version: validWorkflowDetail.version,
      source: 'development',
      buildHash: 'a'.repeat(64),
    },
  }).cities).toEqual(['北京'])

  expect(() => workflowDetailSchema.parse({
    ...validWorkflowDetail,
    cities: ['北京'],
    runtimeIdentity: { id: validWorkflowDetail.id, version: validWorkflowDetail.version,
      source: 'installed', buildHash: 'a'.repeat(64) },
  })).toThrow()
})

it('accepts system-owned status and provenance blocks', () => {
  expect(chatBlockSchema.parse({
    type: 'workflow_status', blockId: 'status_1', executionId: 'exec_1',
    workflowId: 'workflow.beijing', workflowName: '北京工作居住证',
    workflowVersion: '1.0.0', source: 'development', buildHash: 'a'.repeat(64),
    city: '北京', status: 'running', executionIndex: 1, executionLimit: 5,
  }).type).toBe('workflow_status')
  expect(chatBlockSchema.parse({
    type: 'workflow_provenance', blockId: 'provenance_1',
    entries: [{ executionId: 'exec_1', workflowId: 'workflow.beijing',
      workflowName: '北京工作居住证', workflowVersion: '1.0.0',
      source: 'development', buildHash: 'a'.repeat(64), city: '北京', status: 'completed' }],
  }).type).toBe('workflow_provenance')
})
```

- [ ] **Step 2: Run tests and prove they fail**

```bash
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: FAIL because the new identity, city, blocks, approval fields, availability, and error codes do not exist.

- [ ] **Step 3: Implement strict schemas and types**

```ts
export const workflowRuntimeIdentitySchema = z.discriminatedUnion('source', [
  z.object({ id: identifierSchema, version: nonEmptyStringSchema,
    source: z.literal('installed') }).strict(),
  z.object({ id: identifierSchema, version: nonEmptyStringSchema,
    source: z.literal('development'),
    buildHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
])
```

Add `cities` and `runtimeIdentity` to `workflowDetailSchema`, then `superRefine` that ID, version, and source equal the summary fields. Add `chatAvailability: 'ready' | 'not_built' | 'unbuilt_changes' | 'invalid'` to `DeveloperProject`. Approval blocks carry workflow name, source, optional build hash, optional city, and bounded `actionSummary`. Add `CITY_REQUIRED`, `CITY_NOT_SUPPORTED`, `WORKFLOW_CHANGED`, `INVALID_TOOL_SEQUENCE`, `TOOL_CALL_LIMIT`, `INVALID_OUTPUT`, and `RESULT_TOO_LARGE` with safe messages.

- [ ] **Step 4: Build shared output and rerun tests**

```bash
pnpm --filter @autoforge/shared build
pnpm exec vitest run packages/shared/src/contracts.test.ts
```

Expected: PASS; unknown fields and mismatched identities remain rejected.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/desktop-api.ts packages/shared/src/events.ts packages/shared/src/errors.ts packages/shared/src/contracts.test.ts
git commit -m "feat: add workflow tool runtime contracts"
```

---

### Task 2: Propagate cities, shadow duplicates, and expose build availability

**Files:**
- Modify: `apps/desktop/electron/main/workflows/registry.ts:19-98`
- Modify: `apps/desktop/electron/main/workflows/project-service.ts:120-245`
- Create: `apps/desktop/electron/main/workflows/registry.test.ts`
- Modify: `apps/desktop/electron/main/application.ts:430-480,1110-1145`
- Test: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: Task 1 detail and availability contracts.
- Produces: normalized details, deterministic development shadowing, and authoritative project chat availability.

- [ ] **Step 1: Write failing Registry tests**

In the new test file, define `installedWorkflow(overrides)` as a valid installed repository record, `readyProject(overrides)` as a project plus matching `workflow.json`, source, artifact, and hashes, and `registryHarness(input)` as in-memory repository/project ports returning a real `WorkflowRegistry`. Keep all three helpers local to this test file.

```ts
it('normalizes missing cities and shadows an installed identity with a ready development build', async () => {
  const registry = registryHarness({
    installed: [installedWorkflow({ id: 'workflow.same', version: '1.0.0', cities: undefined })],
    projects: [readyProject({ workflowId: 'workflow.same', version: '1.0.0',
      buildHash: 'b'.repeat(64), cities: ['北京'] })],
  })
  expect(await registry.list({ developerMode: false })).toMatchObject([
    { id: 'workflow.same', source: 'installed', cities: [] },
  ])
  expect(await registry.list({ developerMode: true })).toMatchObject([
    { id: 'workflow.same', source: 'development', cities: ['北京'],
      runtimeIdentity: { source: 'development', buildHash: 'b'.repeat(64) } },
  ])
})
```

- [ ] **Step 2: Run the test and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/workflows/registry.test.ts
```

Expected: FAIL because Registry drops `cities`, lacks runtime identity, and returns duplicate identities.

- [ ] **Step 3: Implement normalization and shadowing**

```ts
function identityKey(workflow: Pick<WorkflowDetail, 'id' | 'version'>): string {
  return `${workflow.id}\u0000${workflow.version}`
}
const developmentByIdentity = new Map(
  developmentDetails.map((workflow) => [identityKey(workflow), workflow]),
)
return [
  ...installed.filter((workflow) => !developmentByIdentity.has(identityKey(workflow))),
  ...developmentDetails,
]
```

Both conversion paths use `cities: manifest.cities ?? []`. Development identity uses the persisted verified `project.buildHash`.

- [ ] **Step 4: Mark source/manifest writes unavailable until build**

When `workflow.json` or `src/index.ts` is written outside build completion, change project status away from `ready` while retaining the last build hash. Return availability with:

```ts
function chatAvailability(project: WorkflowProject): WorkflowChatAvailability {
  if (project.status === 'invalid' || project.status === 'error') return 'invalid'
  if (!project.buildHash) return 'not_built'
  return project.status === 'ready' ? 'ready' : 'unbuilt_changes'
}
```

Only successful build restores `ready` after source, manifest, artifact, and hashes agree.

- [ ] **Step 5: Run focused tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/workflows/registry.test.ts electron/main/application.test.ts
```

Expected: PASS for cities, shadowing, edit invalidation, successful build, and installed behavior with developer mode off.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/workflows/registry.ts apps/desktop/electron/main/workflows/registry.test.ts \
  apps/desktop/electron/main/workflows/project-service.ts apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts
git commit -m "feat: expose eligible workflow build identity"
```

---

### Task 3: Bind execution to opaque exact source selectors

**Files:**
- Create: `apps/desktop/electron/main/workflows/workflow-source-selector.ts`
- Create: `apps/desktop/electron/main/workflows/workflow-source-selector.test.ts`
- Modify: `apps/desktop/electron/main/workflows/execution-service.ts:44-61,129-140`
- Modify: `apps/desktop/electron/main/application.ts:590-640`
- Test: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: Task 2 runtime identities and Registry fingerprint checks.
- Produces: `createWorkflowSourceSelectorVault()` with `create(workflow)` and `inspect(selector)`.

- [ ] **Step 1: Write the failing authenticity test**

```ts
it('accepts only selectors created by its vault', () => {
  const vault = createWorkflowSourceSelectorVault()
  const workflow: WorkflowDetail = {
    id: 'workflow.dev', version: '1.0.0', name: '开发工作流', description: '测试',
    author: 'AutoForge', category: 'test', enabled: true, source: 'development',
    integrity: 'valid', updatedAt: '2026-08-22T00:00:00.000Z', cities: ['北京'],
    runtimeIdentity: { id: 'workflow.dev', version: '1.0.0', source: 'development',
      buildHash: 'c'.repeat(64) },
    permissions: [], activationExamples: [], activationNegativeExamples: [],
    timeoutMs: 30_000, inputSchema: {}, outputSchema: {},
  }
  const selector = vault.create(workflow)
  expect(vault.inspect(selector)).toEqual({ id: workflow.id, version: workflow.version,
    source: 'development', buildHash: 'c'.repeat(64) })
  expect(vault.inspect({ kind: 'development-build' } as never)).toBeUndefined()
})
```

- [ ] **Step 2: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/workflows/workflow-source-selector.test.ts
```

Expected: FAIL because the vault does not exist.

- [ ] **Step 3: Implement the Main-only selector vault**

```ts
export type ExactWorkflowSource =
  | { id: string; version: string; source: 'installed'; codeSha256: string }
  | { id: string; version: string; source: 'development'; buildHash: string }

export interface WorkflowExecutionSourceSelector {
  readonly kind: 'installed-build' | 'development-build'
}
```

Store exact values in a `WeakMap`; reject forged selectors. Installed selectors require the manifest code hash. Development selectors require build hash. The application resolver rejects unknown selector, hash change, zero matches, or multiple matching development projects and never falls back to another source.

- [ ] **Step 4: Add resolver race tests**

Capture a selector, mutate the installed code hash or development build hash, then assert execution fails before Worker spawn. Also assert a failed development selector never runs the installed duplicate.

- [ ] **Step 5: Run selector, execution, and application tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/workflows/workflow-source-selector.test.ts \
  electron/main/workflows/execution-service.test.ts electron/main/application.test.ts
```

Expected: PASS with exactly one unchanged source resolved.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/workflows/workflow-source-selector.ts \
  apps/desktop/electron/main/workflows/workflow-source-selector.test.ts \
  apps/desktop/electron/main/workflows/execution-service.ts apps/desktop/electron/main/application.ts \
  apps/desktop/electron/main/application.test.ts
git commit -m "feat: bind workflow execution to exact builds"
```

---

### Task 4: Validate workflow output before persisting success

**Files:**
- Create: `apps/desktop/electron/main/workflows/output-validation.ts`
- Create: `apps/desktop/electron/main/workflows/output-validation.test.ts`
- Modify: `apps/desktop/electron/main/workflows/execution-service.ts:640-675,790-825`
- Modify: `apps/desktop/electron/main/workflows/execution-service.test.ts`

**Interfaces:**
- Consumes: exact resolved `WorkflowDetail.outputSchema`.
- Produces: `validateWorkflowOutput(schema, output)`; invalid output persists `failed/INVALID_OUTPUT` before any completed event.

- [ ] **Step 1: Write failing validation and service tests**

```ts
it('rejects output that violates schema formats', () => {
  const schema = { type: 'object', required: ['url'], additionalProperties: false,
    properties: { url: { type: 'string', format: 'uri' } } }
  expect(validateWorkflowOutput(schema, { url: 'https://example.com' })).toEqual({ valid: true })
  expect(validateWorkflowOutput(schema, { url: 'not a url' })).toEqual({ valid: false })
})

it('persists invalid Worker output as failed', async () => {
  const harness = createHarness({ source: {
    workflow: { ...workflow, outputSchema: {
      type: 'object', required: ['title'], properties: { title: { type: 'string' } },
    } },
    rootPath: trustedRootPath,
    entryPath: 'workers/workflow-runner.ts',
    integrity: 'valid',
  } })
  const started = await harness.start()
  const worker = harness.workerFactory.workers.get(started.id)!
  worker.respond({ type: 'ready', executionId: started.id })
  worker.respond({ type: 'result', output: { title: 42 } })
  await expect(started.finished).resolves.toMatchObject({ status: 'failed', errorCode: 'INVALID_OUTPUT' })
  expect(harness.repositories.records.get(started.id)?.status).toBe('failed')
})
```

- [ ] **Step 2: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/workflows/output-validation.test.ts electron/main/workflows/execution-service.test.ts
```

Expected: FAIL because all Worker results currently persist as completed.

- [ ] **Step 3: Implement AJV plus formats validation**

```ts
export function validateWorkflowOutput(schema: unknown, output: unknown): { valid: boolean } {
  try {
    const ajv = new Ajv({ strict: false })
    addFormats(ajv)
    return { valid: Boolean(ajv.compile(schema as AnySchema)(output)) }
  } catch {
    return { valid: false }
  }
}
```

Validate `message.output` before `finish(..., 'completed')`. On failure, persist `failed/INVALID_OUTPUT` with the local diagnostic output; chat receives only the safe error code. Preserve one terminal event and existing cleanup.

- [ ] **Step 4: Rerun focused tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/workflows/output-validation.test.ts electron/main/workflows/execution-service.test.ts
```

Expected: PASS for schema, format, invalid schema, persistence, event, and cleanup cases.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/main/workflows/output-validation.ts \
  apps/desktop/electron/main/workflows/output-validation.test.ts \
  apps/desktop/electron/main/workflows/execution-service.ts \
  apps/desktop/electron/main/workflows/execution-service.test.ts
git commit -m "feat: validate workflow output contracts"
```

---

### Task 5: Build the immutable catalog and host-owned risk policy

**Files:**
- Create: `apps/desktop/electron/main/agent/workflow-catalog.ts`
- Create: `apps/desktop/electron/main/agent/workflow-catalog.test.ts`
- Create: `apps/desktop/electron/main/agent/capability-risk.ts`
- Create: `apps/desktop/electron/main/agent/capability-risk.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:38-61,208-226,385-405`

**Interfaces:**
- Consumes: Task 2 Registry details and Task 3 selectors.
- Produces: `WorkflowCandidate`, `WorkflowCatalog.create`, model tool wrappers, and `classifyCapability`.

- [ ] **Step 1: Write failing catalog and risk tests**

Define `beijingWorkflow` and `allCitiesWorkflow` as complete `WorkflowDetail` fixtures using Task 1 fields; the first has `cities: ['北京']`, the second has `cities: []`. Define `workflows.list()` to return them in that order and `selectorFor` with the real Task 3 vault.

```ts
it('creates unique tools with city routing outside workflow input', async () => {
  const catalog = await createWorkflowCatalog({ workflows, selectorFor }).create({ developerMode: true })
  expect(catalog.map(({ toolName }) => toolName)).toEqual(['workflow_1', 'workflow_2'])
  expect(catalog[0]!.tool.function.parameters).toEqual({
    type: 'object', additionalProperties: false,
    required: ['resolvedCity', 'input'],
    properties: { resolvedCity: { type: 'string', enum: ['北京'] },
      input: beijingWorkflow.inputSchema },
  })
  expect(catalog[1]!.tool.function.parameters).toMatchObject({ required: ['input'] })
})

it.each([
  ['browser.open', 'safe_navigation'], ['browser.url', 'safe_navigation'],
  ['browser.close', 'safe_navigation'], ['browser.fill', 'external_action'],
  ['browser.click', 'external_action'], ['clipboard.read', 'sensitive_read'],
  ['filesystem.write', 'external_action'], ['future.unknown', 'unknown'],
] as const)('classifies %s as %s', (capability, expected) => {
  expect(classifyCapability(capability)).toBe(expected)
})
```

- [ ] **Step 2: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/workflow-catalog.test.ts electron/main/agent/capability-risk.test.ts
```

Expected: FAIL because the catalog and risk policy do not exist.

- [ ] **Step 3: Implement candidates and tool wrappers**

```ts
export interface WorkflowCandidate {
  key: string
  toolName: string
  workflow: WorkflowDetail
  selector: WorkflowExecutionSourceSelector
  tool: ModelTool
}

function toolParameters(workflow: WorkflowDetail): Record<string, unknown> {
  const restricted = workflow.cities.length > 0
  return { type: 'object', additionalProperties: false,
    required: restricted ? ['resolvedCity', 'input'] : ['input'],
    properties: {
      ...(restricted ? { resolvedCity: { type: 'string', enum: workflow.cities } } : {}),
      input: workflow.inputSchema,
    } }
}
```

Descriptions include name, description, ID/version, exact cities or `不限城市`, category, and positive/negative activation examples. Use opaque per-run names (`workflow_1`, `workflow_2`) so workflow versions and provider naming rules cannot collide.

- [ ] **Step 4: Implement fail-closed risk classification**

Export `CapabilityRisk = 'safe_navigation' | 'sensitive_read' | 'external_action' | 'unsupported' | 'unknown'` and `classifyCapability(capability: string): CapabilityRisk`. Current Worker-unimplemented capabilities are `unsupported`; this task does not enable them.

- [ ] **Step 5: Rerun focused tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/workflow-catalog.test.ts electron/main/agent/capability-risk.test.ts
```

Expected: PASS for unique tools, city wrapper, descriptions, selectors, every current capability, and unknown values.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/main/agent/workflow-catalog.ts \
  apps/desktop/electron/main/agent/workflow-catalog.test.ts \
  apps/desktop/electron/main/agent/capability-risk.ts \
  apps/desktop/electron/main/agent/capability-risk.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts
git commit -m "feat: build city aware workflow catalog"
```

---

### Task 6: Add budget-aware same-model semantic routing

**Files:**
- Create: `apps/desktop/electron/main/agent/workflow-router.ts`
- Create: `apps/desktop/electron/main/agent/workflow-router.test.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.ts:18-55,159-187,328-335`
- Modify: `apps/desktop/electron/main/chat/conversation-context.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`

**Interfaces:**
- Consumes: Task 5 candidates, token estimator, context length, provider snapshot, usage attribution, and abort signal.
- Produces: `resolveChatInputBudget` and `WorkflowRouter.route`.

- [ ] **Step 1: Export and test the authoritative input budget**

```ts
it('uses 60 percent and a 32000 fallback', () => {
  expect(resolveChatInputBudget(100_000)).toBe(60_000)
  expect(resolveChatInputBudget(0)).toBe(19_200)
  expect(resolveChatInputBudget(undefined)).toBe(19_200)
})
```

Replace the private duplicate calculation in `ConversationContextManager` with this helper.

- [ ] **Step 2: Write failing router tests**

Define `smallCandidates` with two complete Task 5 candidates whose tools fit the budget. Define `largeCandidates` with three candidates whose input schemas contain strings large enough to exceed the 20-percent budget. Use `new AbortController().signal` as `signal`.

```ts
it('uses all fitting tools and a same-model ordered shortlist when over budget', async () => {
  const select = vi.fn(async () => ['candidate_3', 'candidate_1'])
  expect(await router.route({ candidates: smallCandidates, contextLength: 32_000,
    select, signal })).toEqual(smallCandidates)
  expect(select).not.toHaveBeenCalled()
  const routed = await router.route({ candidates: largeCandidates, contextLength: 32_000,
    select, signal })
  expect(routed.map(({ key }) => key)).toEqual(['candidate_3', 'candidate_1'])
  expect(routed.length).toBeLessThanOrEqual(20)
})
```

Also assert an oversized compact catalog fails `CONTEXT_LIMIT_EXCEEDED` before `select` and before execution.

- [ ] **Step 3: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/chat/conversation-context.test.ts electron/main/agent/workflow-router.test.ts
```

Expected: FAIL because the helper and router do not exist.

- [ ] **Step 4: Implement deterministic budget logic**

```ts
const MAX_ROUTED_CANDIDATES = 20
const toolBudget = Math.floor(resolveChatInputBudget(input.contextLength) * 0.20)
const completeTokens = estimateRequestTokens({ messages: [],
  tools: input.candidates.map(({ tool }) => tool), currentMedia: [] })
if (completeTokens <= toolBudget) return [...input.candidates]
```

The compact request contains only key, identity, name, description, cities, category, and activation examples. Parse a strict JSON key array, preserve order, deduplicate, reject unknown keys, cap at 20, then take the longest complete-tool prefix fitting the budget. Empty valid selection means direct chat. Malformed output fails safely; never fall back to lexical matching.

- [ ] **Step 5: Wire the internal provider call**

Use operation key `agent:<requestId>:workflow-routing`, the same acquired provider/model/user attribution, no tools/media, and the run abort signal. Emit no chat blocks, persist no routing message, and do not increment the ten normal decisions. Add routing input/output tokens and cost to the same chat run totals so internal routing is not omitted from usage accounting.

- [ ] **Step 6: Rerun focused tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/chat/conversation-context.test.ts electron/main/agent/workflow-router.test.ts
```

Expected: PASS for direct/semantic paths, order, cap, budgets, overflow, cancellation, and usage attribution.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/agent/workflow-router.ts \
  apps/desktop/electron/main/agent/workflow-router.test.ts \
  apps/desktop/electron/main/chat/conversation-context.ts \
  apps/desktop/electron/main/chat/conversation-context.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts
git commit -m "feat: route workflow tools within model budget"
```

---

### Task 7: Enforce tool preflight, approval, and result budgets

**Files:**
- Create: `apps/desktop/electron/main/agent/workflow-tool-executor.ts`
- Create: `apps/desktop/electron/main/agent/workflow-tool-executor.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:250-310,590-690`
- Reuse: `apps/desktop/electron/main/workflows/input-validation.ts`

**Interfaces:**
- Consumes: exact selectors, validated execution status, candidates/risk, budget helper, policy, and execution ports.
- Produces: executor `prepare`, `approve`, `deny`, `start`, and `toModelResult` operations.

- [ ] **Step 1: Write failing boundary tests**

Create a local executor harness with `vi.fn()` implementations for policy, reserve/start/cancel, current developer mode, exact selector inspection, and clock. Its `beijingCandidate` has `cities: ['北京']`; `browserOpenCandidate` is the same identity with one declared `browser.open` permission and valid input schema.

```ts
it('requires exact city before start', async () => {
  const result = await executor.prepare({ candidate: beijingCandidate,
    arguments: { input: { topic: '居住证' } }, developerMode: true })
  expect(result).toEqual({ kind: 'tool_error', code: 'CITY_REQUIRED' })
  expect(executions.reserve).not.toHaveBeenCalled()
})

it('returns semantic input errors and auto-grants safe navigation once', async () => {
  expect(await executor.prepare({ candidate: beijingCandidate,
    arguments: { resolvedCity: '北京', input: {} }, developerMode: true }))
    .toMatchObject({ kind: 'tool_error', code: 'INVALID_INPUT',
      message: expect.stringContaining('不能为空') })
  const prepared = await executor.prepare({ candidate: browserOpenCandidate,
    arguments: { resolvedCity: '北京', input: { topic: '居住证' } }, developerMode: true })
  expect(prepared).toMatchObject({ kind: 'ready' })
  expect(policy.record).toHaveBeenCalledWith(expect.objectContaining({ decision: 'once' }))
})

it('keeps oversized completed output out of model context', () => {
  expect(executor.toModelResult({ result: 'x'.repeat(300 * 1024), contextLength: 128_000 }))
    .toEqual({ kind: 'tool_error', code: 'RESULT_TOO_LARGE' })
})
```

- [ ] **Step 2: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/workflow-tool-executor.test.ts
```

Expected: FAIL because the executor does not exist.

- [ ] **Step 3: Implement wrapper parsing and preflight**

```ts
type WorkflowToolArguments = { resolvedCity?: string; input: unknown }
export type ToolPreparation =
  | { kind: 'tool_error'; code: AppErrorCode; message?: string }
  | { kind: 'awaiting_approval'; pending: PendingWorkflowTool }
  | { kind: 'ready'; pending: PendingWorkflowTool }
```

Reject unknown wrapper keys. Restricted tools require exact city membership. Unrestricted tools omit routing city and use an all-cities provenance marker. Recheck developer mode and exact selector immediately before start. Use `validateWorkflowInput`; cap its model message at 500 characters.

- [ ] **Step 4: Implement chat-only permission behavior**

`safe_navigation` records an execution-scoped once grant. `external_action` and `sensitive_read` return one approval at a time regardless of persistent grants. `unsupported` and `unknown` fail before start. Pending state binds execution, index, exact source, city, capability/scope hash, action summary, and validated input. Denial discards reservation, releases grants, returns `PERMISSION_DENIED` to the model, and does not terminate the Agent.

Generate `actionSummary` in Main from workflow name, capability, city, and bounded key parameters. Replace values for keys matching `password`, `secret`, `token`, `apiKey`, `authorization`, or `cookie` with `***`; cap the final summary at 500 characters before persistence or Renderer emission.

- [ ] **Step 5: Implement result limits**

```ts
const serialized = JSON.stringify(result) ?? 'null'
const tokenLimit = Math.floor(resolveChatInputBudget(contextLength) * 0.25)
if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024
  || estimateTextTokens(serialized) > tokenLimit) {
  return { kind: 'tool_error', code: 'RESULT_TOO_LARGE' }
}
return { kind: 'tool_result', content: serialized }
```

Serialize only result or safe error code; never stack, path, secret, raw approval scope, or sensitive parameter.

- [ ] **Step 6: Rerun executor and application tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/workflow-tool-executor.test.ts electron/main/application.test.ts
```

Expected: PASS for all city states, semantic inputs, mode/build races, permissions, denial, output failure, token/byte limits, and safe serialization.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/agent/workflow-tool-executor.ts \
  apps/desktop/electron/main/agent/workflow-tool-executor.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts
git commit -m "feat: enforce workflow tool execution policy"
```

---

### Task 8: Implement sequential loop state and buffered response ordering

**Files:**
- Create: `apps/desktop/electron/main/agent/workflow-tool-loop.ts`
- Create: `apps/desktop/electron/main/agent/workflow-tool-loop.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts:230-760`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/chat/conversation-context.ts:70-120`
- Modify: `apps/desktop/electron/main/chat/conversation-context.test.ts`

**Interfaces:**
- Consumes: Tasks 5-7 and existing provider/persistence/usage ports.
- Produces: sequential tool protocol, buffered first response, system status/provenance, safe history, limits, repair, retry, and whole-run cancel.

- [ ] **Step 1: Write failing pure state tests**

Define `callA` and `callB` as distinct `ModelStreamEvent` tool calls. Define `clock` with mutable milliseconds, `now: () => milliseconds`, and `advance(delta)`; do not use wall-clock waits.

```ts
it('allows five starts, ten decisions, and one multi-call repair', () => {
  const loop = new WorkflowToolLoop({ now: clock.now })
  expect(loop.acceptToolCalls([callA, callB])).toEqual({ kind: 'repair' })
  expect(loop.acceptToolCalls([callA, callB])).toEqual({ kind: 'failed', code: 'INVALID_TOOL_SEQUENCE' })
  for (let index = 1; index <= 5; index += 1) {
    expect(loop.startExecution(`candidate_${index}`, false)).toEqual({ executionIndex: index })
  }
  expect(loop.canOfferTools()).toBe(false)
})

it('pauses active time during approval and expires approval at thirty minutes', () => {
  const loop = new WorkflowToolLoop({ now: clock.now })
  clock.advance(60_000)
  loop.awaitApproval()
  clock.advance(29 * 60_000)
  expect(loop.approvalExpired()).toBe(false)
  clock.advance(60_001)
  expect(loop.approvalExpired()).toBe(true)
  expect(loop.activeElapsedMs()).toBe(60_000)
})
```

- [ ] **Step 2: Write failing orchestrator ordering tests**

```ts
expect(blocksBeforeWorkflowCompletion).not.toContainEqual(
  expect.objectContaining({ type: 'text', text: '我来帮你查询' }),
)
expect(providerRequests[1]!.messages).toEqual(expect.arrayContaining([
  expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call_1' })] }),
  expect.objectContaining({ role: 'tool', tool_call_id: 'call_1' }),
]))
expect(finalBlocks.at(-1)).toMatchObject({ type: 'workflow_provenance' })
```

Add two sequential successes, denial explanation, failed read-only retry with changed args, no side-effect retry, fifth-call removal, tenth-decision failure, and cancel suppressing later provider text.

Add policy-prompt cases for:

- an explicit user instruction `不要调用工作流` producing a direct response and zero starts;
- two materially different matching workflows producing a clarification rather than shotgun execution;
- the same successful workflow being rejected on a second call unless it is the one allowed corrected read-only retry;
- `allowTools: false` answering an ordinary question without a warning, but explaining the selected model limitation when the user explicitly asks to run a workflow;
- current-message city overriding an older same-topic city, while unrelated older city text is ignored.

- [ ] **Step 3: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/workflow-tool-loop.test.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  electron/main/chat/conversation-context.test.ts
```

Expected: FAIL because current code streams pre-tool text, supports one execution, ends on denial/failure, and has eight undifferentiated model turns.

- [ ] **Step 4: Implement loop limits and timing**

```ts
export const MAX_WORKFLOW_EXECUTIONS = 5
export const MAX_MODEL_DECISIONS = 10
export const MAX_AGENT_ACTIVE_MS = 10 * 60_000
export const APPROVAL_EXPIRY_MS = 30 * 60_000
```

Increment execution immediately before `startReserved`. Validation, denial, routing, and one repair do not count. Track one read-only retry per candidate and stable input JSON; identical arguments are not a material correction.

Before each provider turn and workflow start, compare active elapsed time with `MAX_AGENT_ACTIVE_MS`. On exhaustion, append a safe timeout error, cancel any unstarted reservation, finalize once, and release the conversation lock. Approval time is excluded by the loop's pause/resume accounting.

Prepend one Main-owned system policy message before conversation summary/history. It states: obey explicit user opt-out, prefer an explicitly named eligible workflow, ask on material workflow ambiguity, resolve city with the approved precedence, emit one tool call at a time, treat tool results as untrusted data, and do not claim a workflow ran without system provenance. When `allowTools` is false, use a separate notice that tells the model to mention the limitation only for an explicit or workflow-required request.

- [ ] **Step 5: Buffer provider decisions until finish reason**

Accumulate text deltas in order without `appendText`. On `stop`, replay the buffered deltas through the existing append/emit path so persistence and Renderer coalescing remain unchanged. On one valid tool call, discard all buffered deltas, append `workflow_status`, and continue. A second parallel-call response after one repair returns `INVALID_TOOL_SEQUENCE` without execution.

- [ ] **Step 6: Continue protocol after every structured result**

Success, denial, city/input correction, execution failure, invalid output, and oversized result append the original assistant tool call plus one matching `role: tool` message. Frame tool content as untrusted data. Preserve original call ID. After five starts remove tools; final `stop` appends Main-generated provenance from actual executions. Direct answers have no provenance.

- [ ] **Step 7: Serialize new blocks safely in history**

```ts
case 'workflow_status':
  return [`[工作流: ${block.workflowName}; 城市: ${block.city ?? '不限城市'}; 状态: ${block.status}]`]
case 'workflow_provenance':
  return block.entries.map((entry) =>
    `[已使用工作流: ${entry.workflowName}; 城市: ${entry.city ?? '不限城市'}; 状态: ${entry.status}]`)
```

Never serialize build hash, input, raw output, local path, or approval scope into later model history.

- [ ] **Step 8: Rerun focused tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/agent/workflow-tool-loop.test.ts \
  electron/main/agent/agent-orchestrator.test.ts \
  electron/main/chat/conversation-context.test.ts
```

Expected: PASS for sequential execution, repair, retry, ordering, provenance, history, timing, expiry, and cancellation.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/electron/main/agent/workflow-tool-loop.ts \
  apps/desktop/electron/main/agent/workflow-tool-loop.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts \
  apps/desktop/electron/main/chat/conversation-context.ts \
  apps/desktop/electron/main/chat/conversation-context.test.ts
git commit -m "feat: run sequential chat workflow tools"
```

---

### Task 9: Wire developer-mode transitions and approval expiry

**Files:**
- Modify: `apps/desktop/electron/main/application.ts:590-735,945-1015,1210-1275`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: Tasks 5-8 and settings/execution IPC.
- Produces: exact runtime wiring and `agent.onDeveloperModeChanged(enabled)`.

- [ ] **Step 1: Write failing mode-transition tests**

Add `applicationHarness` beside the existing `options()` and `authenticate()` helpers in `application.test.ts`. It must create the real application with captured provider requests, execution starts, settings API, and an Agent inspection port used only by tests; `sendDevelopmentToolPrompt()` returns after the Agent reaches its injected approval barrier.

```ts
it('invalidates a pending development call when mode closes but retains installed tools', async () => {
  const app = await applicationHarness({ developerMode: true })
  await app.sendDevelopmentToolPrompt()
  await app.settings.update({ developerMode: false })
  expect(app.executions.started).toHaveLength(0)
  expect(app.providerRequests.at(-1)?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'tool', content: expect.stringContaining('WORKFLOW_CHANGED') }),
  ]))
  expect(app.agent.availableInstalledWorkflowIds()).toContain('installed.workflow')
})
```

Add a running-development case: mode off does not kill the Worker; result returns; later development candidates disappear.

- [ ] **Step 2: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/application.test.ts electron/main/agent/agent-orchestrator.test.ts
```

Expected: FAIL because settings updates do not notify active Agent runs.

- [ ] **Step 3: Wire one vault and layered runtime**

Application creates one selector vault; Catalog creates selectors; source resolver inspects them. Pass Registry, router, executor, loop, policy, executions, history, usage, `developerMode`, and `now` to the orchestrator. Remove `retrieveWorkflows` from chat dependency injection without deleting it if another feature uses it.

- [ ] **Step 4: Notify after committed settings change**

```ts
if (previous.developerMode !== updated.developerMode) {
  agent.onDeveloperModeChanged(updated.developerMode)
}
```

On false, pending/unstarted development calls become `WORKFLOW_CHANGED` tool results and release reservations. Running development Workers finish. Installed candidates remain because developer mode does not govern them.

- [ ] **Step 5: Test expiry cleanup with fake timers**

Expiry discards unstarted reservation, releases execution grants, removes execution mapping, finalizes cancelled, unlocks conversation, and emits one terminal status. Never use a real 30-minute wait.

- [ ] **Step 6: Rerun tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/application.test.ts electron/main/agent/agent-orchestrator.test.ts
```

Expected: PASS for off-at-start, off-before-start, off-while-running, installed continuity, expiry, execution-card cancel, chat cancel, and one terminal event.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts
git commit -m "feat: wire dynamic chat workflow policy"
```

---

### Task 10: Render status, approval, provenance, and build availability

**Files:**
- Create: `apps/desktop/src/components/chat/WorkflowStatusCard.vue`
- Create: `apps/desktop/src/components/chat/WorkflowProvenance.vue`
- Modify: `apps/desktop/src/components/chat/MessageBlock.vue:1-70`
- Modify: `apps/desktop/src/components/chat/ApprovalCard.vue:1-100`
- Modify: `apps/desktop/src/stores/chat.ts:75-125,675-730`
- Modify: `apps/desktop/src/stores/developer.ts:70-125`
- Modify: `apps/desktop/src/components/developer/CodeEditor.vue`
- Modify: `apps/desktop/tests/components/chat.test.ts`
- Modify: `apps/desktop/tests/components/developer.test.ts`

**Interfaces:**
- Consumes: Task 1 blocks/availability and Task 8 event order.
- Produces: sequential status, one-time approval, expandable provenance, execution navigation, and unbuilt messaging.

- [ ] **Step 1: Write failing component tests**

```ts
it('renders workflow status and exact call index', () => {
  const wrapper = mount(MessageBlock, { props: { block: {
    type: 'workflow_status', blockId: 'status_1', executionId: 'exec_1',
    workflowId: 'workflow.beijing', workflowName: '北京工作居住证',
    workflowVersion: '1.0.0', source: 'development', buildHash: 'a'.repeat(64),
    city: '北京', status: 'running', executionIndex: 1, executionLimit: 5, id: 'ui_status_1',
  } } })
  expect(wrapper.text()).toContain('正在调用 北京工作居住证')
  expect(wrapper.text()).toContain('北京')
  expect(wrapper.text()).toContain('1 / 5')
})

it('offers only deny and once in chat', () => {
  const wrapper = mount(ApprovalCard, { props: { approval: {
    type: 'approval', executionId: 'exec_1', workflowId: 'workflow.beijing',
    workflowName: '北京工作居住证', workflowVersion: '1.0.0', source: 'development',
    buildHash: 'a'.repeat(64), city: '北京', actionSummary: '填写并点击提交',
    permissionIndex: 0, capability: 'browser.click', scope: { origins: ['https://example.com'] },
    scopeHash: 'b'.repeat(64),
  } } })
  expect(wrapper.find('[data-testid="approve-always"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="deny-approval"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="approve-once"]').exists()).toBe(true)
})
```

Add `unbuilt_changes` test for exact text `有未构建修改，暂不可用于聊天`.

- [ ] **Step 2: Run and prove failure**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts \
  tests/components/chat.test.ts tests/components/developer.test.ts
```

Expected: FAIL because new blocks are not rendered and approval still exposes always.

- [ ] **Step 3: Implement status and provenance**

Status maps exact states and links execution detail. Provenance renders `已使用：<name> · <city>` and expands multiple entries. `RESULT_TOO_LARGE` displays `执行完成，结果未提供给模型` without rewriting execution status.

- [ ] **Step 4: Restrict approval and show bound details**

Remove always button/branch. Display identity, city or `不限城市`, action summary, capability, and scope. Submit strict once/deny only.

- [ ] **Step 5: Merge by stable system identity**

Use `blockId` for status/provenance identity; preserve text coalescing, media update, approval dedupe, and conversation locking. Never derive provenance from model text.

- [ ] **Step 6: Show authoritative developer availability**

```ts
chatAvailabilityMessage(): string {
  const value = this.selectedProject?.chatAvailability
  if (value === 'unbuilt_changes') return '有未构建修改，暂不可用于聊天'
  if (value === 'not_built') return '尚未构建，暂不可用于聊天'
  if (value === 'invalid') return '项目无效，暂不可用于聊天'
  return ''
}
```

Render by editor status; never build on chat or mount.

- [ ] **Step 7: Rerun Renderer tests**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.config.ts \
  tests/components/chat.test.ts tests/components/developer.test.ts
```

Expected: PASS for states, link, provenance, all-cities, once-only approval, merge, cancel, lock, and availability.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/chat/WorkflowStatusCard.vue \
  apps/desktop/src/components/chat/WorkflowProvenance.vue \
  apps/desktop/src/components/chat/MessageBlock.vue apps/desktop/src/components/chat/ApprovalCard.vue \
  apps/desktop/src/stores/chat.ts apps/desktop/src/stores/developer.ts \
  apps/desktop/src/components/developer/CodeEditor.vue \
  apps/desktop/tests/components/chat.test.ts apps/desktop/tests/components/developer.test.ts
git commit -m "feat: show chat workflow execution provenance"
```

---

### Task 11: Prove Provider -> Workflow -> Provider end to end

**Files:**
- Modify: `apps/desktop/tests/integration/agent-workflow.test.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`

**Interfaces:**
- Consumes: Tasks 1-10.
- Produces: deterministic end-to-end regression coverage and final verification evidence.

- [ ] **Step 1: Replace lexical fixture assumptions with city wrapper**

Read the opaque tool name from the first request and call it:

```ts
const firstBody = JSON.parse(String(requests[0]!.body)) as {
  tools: Array<{ function: { name: string } }>
}
const selectedToolName = firstBody.tools[0]!.function.name
const toolCall = { index: 0, id: 'tool_original', function: {
  name: selectedToolName,
  arguments: JSON.stringify({ resolvedCity: '北京',
    input: { keyword: '北京工作居住证' } }),
} }
```

Use user text `我想办理北京工作居住证`, not an exact activation example.

- [ ] **Step 2: Add sequential and direct integration cases**

Assert two tool turns start Workers in order; first result is in the second decision; final text persists after both. Add unrelated direct answer, developer-mode-off zero dev starts, omitted/empty city eligibility, unknown-city clarification without execution, and exact final provenance.

- [ ] **Step 3: Run focused node and Renderer suites**

```bash
cd apps/desktop
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  tests/integration/agent-workflow.test.ts \
  electron/main/agent/agent-orchestrator.test.ts electron/main/application.test.ts
node scripts/run-vitest-electron.mjs run --config vitest.config.ts \
  tests/components/chat.test.ts tests/components/developer.test.ts
```

Expected: PASS with no skipped test or unhandled rejection.

- [ ] **Step 4: Build shared packages, typecheck, test, and build**

```bash
pnpm --filter @autoforge/workflow-schema build
pnpm --filter @autoforge/shared build
pnpm typecheck
pnpm test
pnpm build
```

Expected: every command exits 0 under Electron 43 ABI 148.

- [ ] **Step 5: Perform visible Electron acceptance**

Using the normal development command and the exact repository PID/cwd, verify:

1. Mode off: natural Beijing prompt starts no development workflow.
2. Mode on with ready Beijing build: status appears, final answer waits, provenance shows exact development build and `北京`.
3. `工作居住证怎么办` asks city and creates no execution row.
4. Unrelated question has no workflow status/provenance.
5. Source edit shows `有未构建修改，暂不可用于聊天`; build restores eligibility.
6. Cancel stops Agent/Worker and no later model text appears.
7. `browser.fill` or `browser.click` shows only reject/once approval.
8. Execution record input, output, duration, exact source, terminal state, and provenance agree.

Inspect Main, Renderer, listener, SQLite, and visible UI. Startup logs, HTTP success, or a completed row alone are not acceptance.

- [ ] **Step 6: Commit integration coverage**

```bash
git add apps/desktop/tests/integration/agent-workflow.test.ts \
  apps/desktop/electron/main/agent/agent-orchestrator.test.ts \
  apps/desktop/electron/main/application.test.ts
git commit -m "test: cover chat workflow tool runtime"
```

- [ ] **Step 7: Review final diff against the spec**

```bash
git diff --check
git status --short
git log --oneline -12
```

Expected: no whitespace errors, no unrelated files, user-owned baseline retained, and every acceptance criterion mapped to a passing automated or visible Electron check.

## Spec Coverage Index

- Basic routing, user opt-out/named workflow, model-without-tools behavior: Tasks 6, 8, 11.
- Developer mode, installed continuity, ready build, edit invalidation, duplicate shadowing: Tasks 2, 3, 9, 10, 11.
- Cities omitted/empty/restricted/unknown/alias/multiple and approved precedence: Tasks 1, 2, 5, 7, 8, 11.
- Semantic candidate budgeting, compact routing, 20-candidate cap: Task 6.
- Five sequential starts, ten decisions, one repair, retry policy: Task 8.
- Exact source/version/build binding and no fallback: Tasks 2, 3, 7, 9.
- Input semantics, output schema, model-result size: Tasks 4 and 7.
- Capability risk, once-only chat approval, denial continuation: Tasks 5, 7, 8, 10.
- Preamble buffering, status, final provenance, safe durable history: Tasks 1, 8, 10.
- Whole-run cancellation, active timeout, approval expiry, same-conversation lock: Tasks 8 and 9.
- Prompt-injection boundary, safe errors, no sensitive history: Tasks 1, 7, 8.
- Renderer -> Preload -> IPC -> Main -> Provider -> Worker -> Provider -> Renderer acceptance: Task 11.
