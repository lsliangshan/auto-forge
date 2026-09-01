# Workflow Input Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让任意工作流保留各自不同的参数名、类型和数量，由模型只提取用户当前明确提供的部分参数，再由 Electron Main 确定性地合并、补默认值和运行时绑定、严格校验、跨轮追问并在输入完整后进入既有执行链路。

**Architecture:** 在 Electron Main 新增深模块 `WorkflowInputResolver`，以原始严格 JSON Schema 为执行权威，同时生成允许部分参数的模型投影。`AgentOrchestrator` 只编排意图选择、参数收集持久化和聊天续接；SQLite 仓储保证每个会话最多一个 pending 收集、CAS 更新、24 小时过期和终态清值；`WorkflowToolExecutor` 保留最后一道严格校验及既有权限、预算和执行逻辑。

**Tech Stack:** TypeScript、Electron Main、AJV、better-sqlite3、Vitest、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-01-workflow-input-resolution-design.md`

## Global Constraints

- 开始每个任务前运行 `git status --short` 和该任务涉及文件的 `git diff -- <paths>`。当前工作区已有大量用户修改，尤其是 `application.ts`、工作流 Schema、shared contracts 和三个示例工作流；只做与本功能直接对应的行级改动。
- 不修改 Renderer 数据契约，不新增表单、卡片或同步协议；参数追问只使用普通 assistant 文本。
- 不把 `workflow_input_collections` 加到 user-cache migrations、CloudBase Schema、同步 payload 或 Renderer bridge。
- 模型永远只提交当前消息中明确出现的参数补丁。原始严格 Schema、持久化 partial input、默认值和 Main 运行时绑定均不交给模型决定。
- 参数值、完整工具参数、personal 值不得进入日志、diagnostics、safe error、执行摘要或工具错误消息。测试 fixture 中可使用虚构值，但断言日志时必须确认值不存在。
- `secret` 注解在首版直接拒绝；不得把模型供应商、登录或平台凭据实现成工作流绑定。
- 除非另行获得授权，不运行 headed Browser、Chrome、Computer Use 或 headed Playwright/E2E。
- 每个任务遵循 red-green-refactor：先写并运行单一失败测试，再写最少实现，通过目标测试后再提交。不要把用户已有未提交改动包含进任务提交；用 `git diff --cached --name-only` 核对暂存范围。任务开始时已 dirty 的路径不得用整文件 `git add`，也不得交互式暂存；其中的功能改动保留未暂存并在最终交付中列明。任务提交只包含开始时 clean 的已修改路径和新增文件。
- 开始产品代码实现前调用 `superpowers:test-driven-development`；执行整份计划时调用 `superpowers:subagent-driven-development`（推荐，同一会话）或 `superpowers:executing-plans`（独立会话）。
- 新增稳定错误码仅限 `WORKFLOW_BINDING_UNAVAILABLE`；CAS 冲突继续使用 `CONFLICT`，Schema/工作流身份变化继续使用 `WORKFLOW_CHANGED`，非法 Schema 或模型参数继续使用既有 `INVALID_INPUT` 或 `MODEL_PROVIDER_REQUEST_FAILED`。
- 解析器只返回 `ready | needs_input`；`no_match` 只属于工作流路由或配置项意图选择。
- 参数收集的可靠交互范围是对象根 Schema。既有布尔、数组或 primitive 根 Schema 的完整输入仍须按原严格 Schema 直接执行；这类 Schema 的不完整输入不能创建对象型 partial collection，必须用不含参数值的 `INVALID_INPUT` 安全失败。

---

## Task 1: 定义输入注解和稳定错误契约

**Files:**

- Modify: `packages/workflow-sdk/src/define-workflow.ts`
- Modify: `packages/workflow-sdk/src/index.ts`
- Modify: `packages/shared/src/errors.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Create: `packages/workflow-schema/src/input-schema-metadata.ts`
- Create: `packages/workflow-schema/src/input-schema-metadata.test.ts`
- Modify: `packages/workflow-schema/src/validator.ts`
- Modify: `packages/workflow-schema/src/validator.test.ts`
- Modify: `packages/workflow-schema/src/index.ts`

**Interfaces produced:**

```ts
export type WorkflowInputBinding = 'current-date' | 'current-user' | 'attachments'
export type WorkflowInputSensitivity = 'personal' | 'secret'

export interface WorkflowInputSchemaMetadataDiagnostic {
  path: string
  message: string
}

export function validateWorkflowInputSchemaMetadata(
  schema: unknown,
): readonly WorkflowInputSchemaMetadataDiagnostic[]
```

`validateManifest()` consumes the metadata diagnostics after the existing manifest JSON Schema validation succeeds. `getConfig()` item schemas later consume the same validator through the Resolver compiler.

- [ ] Inspect existing user changes before editing:

  ```bash
  git diff -- packages/shared/src/errors.ts packages/shared/src/contracts.test.ts packages/workflow-schema/manifest.schema.json packages/workflow-schema/src/manifest.ts packages/workflow-schema/src/validator.ts packages/workflow-schema/src/validator.test.ts packages/workflow-sdk/src/define-workflow.ts packages/workflow-sdk/src/index.ts
  ```

  Preserve all unrelated edits. Do not change `manifest.schema.json` merely to describe arbitrary nested JSON Schema keywords; recursive annotation validation belongs in `input-schema-metadata.ts`.

- [ ] Add failing SDK/schema/shared tests covering these exact rules:

  - no annotation remains valid and backward compatible;
  - each of `current-date`, `current-user`, `attachments`, and `personal` is accepted;
  - unknown binding and sensitivity strings are rejected with an exact JSON Pointer path;
  - `x-autoforge-sensitive: secret` is rejected;
  - a `personal` property carrying `default` is rejected;
  - `$async: true` anywhere and `$ref` or `$dynamicRef` not starting with `#` are rejected;
  - the new `WORKFLOW_BINDING_UNAVAILABLE` error code parses and has a non-sensitive safe message.

- [ ] Run the new tests and confirm RED:

  ```bash
  pnpm --filter @autoforge/workflow-schema exec vitest run src/input-schema-metadata.test.ts src/validator.test.ts
  pnpm --filter @autoforge/shared exec vitest run src/contracts.test.ts
  pnpm --filter @autoforge/workflow-sdk typecheck
  ```

  Expected: missing exports, missing error code, and annotation fixtures fail.

- [ ] Implement a cycle-safe recursive walker over actual Schema positions only. Traverse `properties`, `patternProperties`, `$defs`, `definitions`, `dependentSchemas`, Schema-valued `dependencies`, `allOf`, `anyOf`, `oneOf`, `prefixItems`, and the single-Schema keywords already enumerated in `workflow-catalog.ts`. Do not inspect values nested under `const`, `enum`, `default`, or examples as schemas.

- [ ] Return deterministic diagnostics in traversal order with escaped JSON Pointer segments. Use messages that name the invalid annotation or unsupported reference but never include a property value other than the fixed annotation token.

- [ ] In `validateManifest()`, preserve current structural diagnostics; only when structural validation passes, validate `manifest.inputSchema` metadata and convert diagnostics to the existing `ValidationResult` shape.

- [ ] Add `WORKFLOW_BINDING_UNAVAILABLE` to `appErrorCodeSchema` and `safeErrorMessages` with the text `The required workflow runtime binding is unavailable.`

- [ ] Export the SDK literal unions and workflow-schema metadata validator. Keep existing manifest types source compatible.

- [ ] Run GREEN and package typechecks:

  ```bash
  pnpm --filter @autoforge/workflow-schema exec vitest run src/input-schema-metadata.test.ts src/validator.test.ts
  pnpm --filter @autoforge/workflow-schema typecheck
  pnpm --filter @autoforge/shared exec vitest run src/contracts.test.ts
  pnpm --filter @autoforge/shared typecheck
  pnpm --filter @autoforge/workflow-sdk typecheck
  ```

  Expected: all commands exit 0.

- [ ] Commit only files that were clean at Task 1 start. In the current baseline, leave `packages/shared/src/contracts.test.ts` and `packages/workflow-schema/src/validator.test.ts` unstaged because they already contain user changes:

  ```bash
  git add packages/workflow-sdk/src/define-workflow.ts packages/workflow-sdk/src/index.ts packages/shared/src/errors.ts packages/workflow-schema/src/input-schema-metadata.ts packages/workflow-schema/src/input-schema-metadata.test.ts packages/workflow-schema/src/validator.ts packages/workflow-schema/src/index.ts
  git diff --cached --name-only
  git commit -m "feat: define workflow input metadata contract"
  ```

## Task 2: 编译严格 Schema 和模型投影

**Files:**

- Create: `apps/desktop/electron/main/agent/workflow-input-schema.ts`
- Create: `apps/desktop/electron/main/agent/workflow-input-schema.test.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-catalog.ts`

**Interfaces produced:**

```ts
export interface WorkflowInputPathMetadata {
  readonly pointer: string
  readonly schema: Readonly<Record<string, unknown>>
}

export interface WorkflowInputContract {
  readonly originalSchema: unknown
  readonly modelSchema: unknown
  readonly schemaFingerprint: string
  readonly defaults: readonly WorkflowInputPathMetadata[]
  readonly bindings: readonly (WorkflowInputPathMetadata & {
    binding: WorkflowInputBinding
  })[]
  readonly personalPaths: readonly string[]
  readonly interactiveDiagnostics: readonly {
    kind: 'ambiguous_branch'
    pointer: string
  }[]
}

export function compileWorkflowInputContract(schema: unknown): WorkflowInputContract
```

- [ ] Add failing projection/compiler tests for two unrelated workflow Schemas with different field names and counts. Assert that:

  - `required` is removed recursively from model projections;
  - root `properties` and all semantic constraints remain;
  - bound properties are removed from model-visible `properties`;
  - every `x-autoforge-*` key is removed recursively;
  - local `$ref` and `$defs` still compile after adding a unique `$id` boundary;
  - literal `{ "$ref": "#not-a-schema" }` under `const` is untouched as data;
  - original input is cloned, frozen, and unchanged;
  - canonical fingerprints are equal for key-order-only differences and differ for semantic differences;
  - complete boolean, array, and primitive root Schemas retain their original model/execution meaning;
  - incomplete ambiguous `oneOf` records an interactive diagnostic while a complete branch remains representable;
  - metadata validator failures throw safe `INVALID_INPUT` without parameter values.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-input-schema.test.ts --config vitest.node.config.ts
  ```

- [ ] Move the local-reference boundary and AutoForge annotation traversal knowledge out of private `workflow-catalog.ts` helpers into the compiler. Use `node:crypto` SHA-256 over a recursive canonical JSON serializer that sorts object keys and preserves array order.

- [ ] Implement projection with these fixed semantics:

  ```text
  schema clone
    -> recursively delete required
    -> recursively delete x-autoforge-* keys
    -> remove properties carrying x-autoforge-binding
    -> keep type/title/description/enum/const/format/pattern/ranges/local refs
    -> inject an urn:autoforge:workflow-input:<fingerprint> $id only when local refs need a boundary and no $id exists
    -> deep freeze contract and both schema snapshots
  ```

  Keep `additionalProperties` unchanged. A patch may be partial, but unknown fields must not become model-valid.

- [ ] For `oneOf`, `anyOf`, `if/then/else`, dependent schemas, and related complex branches, preserve candidate branch descriptions in the model projection but remove nested `required`. Record stable branch pointers for deterministic disambiguation; do not pick a branch in the compiler.

- [ ] Expose a small `withWorkflowToolBoundary(schema, toolName)` helper only if provider tool compilation still requires the tool-specific `$id`. Keep the schema compiler as the single owner of Schema-position traversal.

- [ ] Run GREEN:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-input-schema.test.ts electron/main/agent/workflow-catalog.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Commit:

  ```bash
  git add apps/desktop/electron/main/agent/workflow-input-schema.ts apps/desktop/electron/main/agent/workflow-input-schema.test.ts apps/desktop/electron/main/agent/workflow-catalog.ts
  git diff --cached --name-only
  git commit -m "feat: compile workflow input projections"
  ```

## Task 3: 实现 WorkflowInputResolver 深模块

**Files:**

- Create: `apps/desktop/electron/main/agent/workflow-input-resolver.ts`
- Create: `apps/desktop/electron/main/agent/workflow-input-resolver.test.ts`
- Modify: `apps/desktop/electron/main/workflows/input-validation.ts`
- Modify: `apps/desktop/electron/main/workflows/input-validation.test.ts`

**Interfaces produced:**

```ts
export interface WorkflowInputRuntimeBindings {
  readonly currentDate?: string
  readonly currentUser?: string
  readonly attachmentIndexes?: readonly number[]
}

export interface ExistingWorkflowInputCollection {
  readonly schemaFingerprint: string
  readonly partialInput: Readonly<Record<string, unknown>>
  readonly consecutiveNoProgress: number
}

export type WorkflowInputResolverResult =
  | {
      readonly kind: 'ready'
      readonly input: Readonly<Record<string, unknown>>
      readonly schemaFingerprint: string
      readonly acceptedProgress: boolean
    }
  | {
      readonly kind: 'needs_input'
      readonly partialInput: Readonly<Record<string, unknown>>
      readonly schemaFingerprint: string
      readonly diagnostics: readonly WorkflowInputDiagnostic[]
      readonly questions: readonly string[]
      readonly acceptedProgress: boolean
      readonly consecutiveNoProgress: number
    }

export class WorkflowInputResolver {
  project(schema: unknown): WorkflowInputContract
  resolve(input: {
    originalSchema: unknown
    existingCollection?: ExistingWorkflowInputCollection
    patch: unknown
    runtimeBindings: WorkflowInputRuntimeBindings
  }): WorkflowInputResolverResult
}
```

`WorkflowInputDiagnostic` contains only `kind`, JSON Pointer `path`, and safe constraint metadata such as allowed enum labels or numeric bounds. It never contains actual or rejected parameter values.

- [ ] Add failing resolver tests for:

  - complete input returning `ready` directly;
  - required-field questions ordered by Schema property order and grouped to at most three siblings;
  - an invalid field correction being asked alone;
  - recursive object merge, scalar replacement, array replacement, and absent-field preservation;
  - explicit `null` accepted only by a nullable property;
  - unknown and bound patch fields ignored and classified without persisting their values;
  - valid changed leaves setting `acceptedProgress: true` and resetting no-progress to 0;
  - repeated, unknown, or locally invalid values setting `acceptedProgress: false` and incrementing the existing counter;
  - static defaults applied only to absent reachable paths and never overwriting explicit values;
  - personal/default rejection inherited from the compiler;
  - `current-date`, `current-user`, and `attachments` bindings overriding attempted patches and passing final type validation;
  - missing or Schema-incompatible `current-date`/`current-user` binding throwing `WORKFLOW_BINDING_UNAVAILABLE`;
  - an absent or empty `attachments` binding that cannot satisfy attachment constraints returning `needs_input` with a value-free “请附加文件” question;
  - local refs validating strictly, remote refs and `$async` failing closed;
  - complete complex branches returning `ready`, ambiguous incomplete branches returning one deterministic disambiguation question;
  - questions and diagnostics not containing virtual personal fixture values.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-input-resolver.test.ts --config vitest.node.config.ts
  ```

- [ ] Extend `input-validation.ts` without weakening `WorkflowToolExecutor` validation. Add an all-errors compile helper that rejects async validators and preserves current `validateWorkflowInput()` behavior for existing callers:

  ```ts
  export interface CompiledWorkflowInputValidator {
    validate(value: unknown): readonly WorkflowInputValidationIssue[]
  }

  export function compileWorkflowInputValidator(
    schema: unknown,
  ): CompiledWorkflowInputValidator
  ```

- [ ] Implement accepted-patch filtering before merge. Recurse through object properties; accept a changed scalar, array, or explicit nullable `null` only when that node's Schema validates in the original root reference context. Do not store rejected leaves, unknown fields, or runtime-bound paths.

- [ ] Implement merge with immutable values:

  ```text
  canonical stored partial
    -> recursively merge accepted object patch
    -> replace arrays and scalars
    -> apply reachable missing defaults
    -> write non-overridable Main bindings
    -> validate against original strict Schema with allErrors
  ```

  A default below an absent object parent does not materialize that parent unless the parent itself has a default; this avoids silently inventing a required business object.

- [ ] Classify AJV issues into `missing_required`, `invalid_type`, `invalid_format`, `invalid_enum`, `invalid_range`, `additional_property`, `ambiguous_branch`, and `attachment_required`. Keep only path and safe Schema-derived constraints. `attachment_required` is recoverable because the user can add current-message attachments; unavailable non-user-supplied bindings throw the stable binding error.

- [ ] Implement deterministic Chinese questions using `title`, then property name, with optional `description`, `format`, enum labels, and bounds. Never forward AJV's raw message. Invalid correction wins over missing-field questions; otherwise choose at most three missing fields sharing the first missing field's parent.

- [ ] Keep defaults and binding-produced values out of persisted `partialInput`; return a strict final `input` only for `ready`. This ensures next-turn rebinding uses current Main context and terminal rows do not retain derived values.

- [ ] Run GREEN and regression tests:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-input-resolver.test.ts electron/main/workflows/input-validation.test.ts electron/main/agent/workflow-tool-executor.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Commit:

  ```bash
  git add apps/desktop/electron/main/agent/workflow-input-resolver.ts apps/desktop/electron/main/agent/workflow-input-resolver.test.ts apps/desktop/electron/main/workflows/input-validation.ts apps/desktop/electron/main/workflows/input-validation.test.ts
  git diff --cached --name-only
  git commit -m "feat: resolve partial workflow input"
  ```

## Task 4: 持久化参数收集并实现 CAS 生命周期

**Files:**

- Create: `apps/desktop/resources/migrations/0021_workflow_input_collections.sql`
- Modify: `apps/desktop/electron/main/database/repositories.ts`
- Create: `apps/desktop/electron/main/database/workflow-input-collections.test.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

**Interfaces produced:**

```ts
export type WorkflowInputCollectionStatus =
  | 'pending'
  | 'resolved'
  | 'cancelled'
  | 'expired'
  | 'invalidated'

export interface WorkflowInputCollectionRecord {
  id: string
  conversationId: string
  status: WorkflowInputCollectionStatus
  workflowId: string
  workflowVersion: string
  source: string
  buildHash?: string
  configKey?: string
  schemaFingerprint: string
  partialInput?: Readonly<Record<string, unknown>>
  diagnostics: readonly WorkflowInputCollectionDiagnostic[]
  consecutiveNoProgress: number
  revision: number
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export interface WorkflowInputCollectionsRepository {
  createPending(value: NewWorkflowInputCollection): WorkflowInputCollectionRecord
  getPending(conversationId: string, now: number): WorkflowInputCollectionRecord | undefined
  updatePending(value: WorkflowInputCollectionPendingUpdate): WorkflowInputCollectionRecord | undefined
  transition(value: WorkflowInputCollectionTransition): WorkflowInputCollectionRecord | undefined
  expirePending(now: number): number
}
```

`updatePending` and `transition` include `id` plus `expectedRevision`; `undefined` means CAS miss and the caller converts it to safe `CONFLICT`.

- [ ] Add failing migration/repository tests asserting table columns, status/counter/revision checks, conversation foreign key cascade, one-pending-per-conversation partial unique index, and terminal rows requiring `partial_input_json IS NULL`.

- [ ] Add failing behavior tests:

  - create and read pending;
  - second pending row for the same conversation fails safely;
  - valid expected revision updates and increments revision;
  - stale expected revision returns `undefined` and changes nothing;
  - accepted progress can update `expiresAt` to `now + 86_400_000`;
  - no-progress updates `updatedAt` and counter but preserve `expiresAt`;
  - terminal transition clears partial input and diagnostics atomically;
  - lazy `getPending()` expires stale state and returns `undefined`;
  - startup `expirePending()` expires every stale row;
  - deleting a conversation cascades collection deletion.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/database/workflow-input-collections.test.ts electron/main/database/database.test.ts --config vitest.node.config.ts
  ```

- [ ] Create the migration with explicit constraints:

  ```sql
  CREATE TABLE workflow_input_collections (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'cancelled', 'expired', 'invalidated')),
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    source TEXT NOT NULL,
    build_hash TEXT,
    config_key TEXT,
    schema_fingerprint TEXT NOT NULL,
    partial_input_json TEXT,
    diagnostics_json TEXT NOT NULL,
    consecutive_no_progress INTEGER NOT NULL CHECK (consecutive_no_progress >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    CHECK (status = 'pending' OR partial_input_json IS NULL)
  );

  CREATE UNIQUE INDEX workflow_input_collections_one_pending_per_conversation
    ON workflow_input_collections(conversation_id)
    WHERE status = 'pending';
  ```

- [ ] Implement row parsing with strict status, object partial input, metadata-only diagnostics, finite nonnegative integers, and no permissive fallback. Repository parse failure must fail closed.

- [ ] Implement terminal transition as one `UPDATE` statement guarded by `status = 'pending' AND revision = @expectedRevision`, setting `partial_input_json = NULL`, `diagnostics_json = '[]'`, incrementing revision, and updating timestamps.

- [ ] Add `workflowInputCollections` to `AppRepositories` and to the object returned by `createRepositories()`. Do not add it to legacy read-only overrides or user-data repositories.

- [ ] Run GREEN:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/database/workflow-input-collections.test.ts electron/main/database/database.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Commit:

  ```bash
  git add apps/desktop/resources/migrations/0021_workflow_input_collections.sql apps/desktop/electron/main/database/repositories.ts apps/desktop/electron/main/database/workflow-input-collections.test.ts apps/desktop/electron/main/database/database.test.ts
  git diff --cached --name-only
  git commit -m "feat: persist workflow input collections"
  ```

## Task 5: 让 WorkflowCatalog 暴露部分输入工具契约

**Files:**

- Modify: `apps/desktop/electron/main/agent/workflow-catalog.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-catalog.test.ts`

**Interface change:**

```ts
export interface WorkflowCandidate {
  key: string
  toolName: string
  workflow: WorkflowDetail
  selector: WorkflowExecutionSourceSelector
  inputContract: WorkflowInputContract
  tool: ModelTool
}
```

- [ ] Change existing catalog expectations first. The outer envelope remains strict and backward compatible:

  ```ts
  {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: {
      input: candidate.inputContract.modelSchema,
    },
  }
  ```

  City-restricted candidates continue to require `resolvedCity` outside `input`. Nested workflow `required` fields are absent from the model projection.

- [ ] Add failing tests proving:

  - a model call with `{ input: {} }` validates against a workflow that has strict required fields;
  - a complete old call still validates;
  - two workflows receive distinct projections;
  - bound fields are invisible;
  - local refs, literal refs, immutable snapshots, and tool-specific boundary tests remain green;
  - original strict Schema is available through `inputContract.originalSchema` for execution resolution.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-catalog.test.ts --config vitest.node.config.ts
  ```

- [ ] Inject or instantiate one `WorkflowInputResolver` per catalog, call `project()` once per workflow, store the immutable contract on the candidate, and construct tool parameters from `modelSchema`. Remove duplicated Schema traversal helpers left in the catalog.

- [ ] Run GREEN:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-catalog.test.ts electron/main/agent/workflow-input-schema.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Commit:

  ```bash
  git add apps/desktop/electron/main/agent/workflow-catalog.ts apps/desktop/electron/main/agent/workflow-catalog.test.ts
  git diff --cached --name-only
  git commit -m "feat: expose partial workflow tool input"
  ```

## Task 6: 配置项选择只判断意图并返回部分参数

**Files:**

- Modify: `apps/desktop/electron/main/agent/workflow-config-selector.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-config-selector.test.ts`

**Interfaces produced/changed:**

```ts
export interface WorkflowConfigItemSnapshot {
  readonly key: string
  readonly description: string
  readonly cities: readonly string[]
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export function inspectWorkflowConfigItem(
  config: unknown,
  key: string,
): WorkflowConfigItemSnapshot | undefined
```

`WorkflowConfigSelection.kind === 'match'` continues to include `key`, partial `input`, `inputSchema`, and optional `resolvedCity`.

- [ ] Replace the existing “missing required input is no_match” expectation with failing tests that accept `{ decision: 'match', key, input: {} }` for a matching configured item whose Schema requires `birthDate`.

- [ ] Add tests that continue to reject:

  - unknown key;
  - unsupported or non-explicit city;
  - unknown partial input properties;
  - locally invalid supplied leaf values;
  - invalid metadata, `$async`, and remote refs in any config item Schema;
  - extra top-level selection keys.

  Keep true intent mismatch as `{ kind: 'no_match' }`.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-config-selector.test.ts --config vitest.node.config.ts
  ```

- [ ] Update the selection prompt to say that missing input does not prevent a match and that `input` must contain only values explicit in the current request. Present each config item with the Resolver's permissive model projection rather than its strict Schema.

- [ ] Replace final strict `validateWorkflowInput(item.inputSchema, value.input)` with Resolver-compatible partial patch validation. The selector must not apply defaults, bindings, merge state, or decide completeness.

- [ ] Implement `inspectWorkflowConfigItem()` using the same config parser and immutable Schema snapshot so restart recovery can retrieve the exact configured item without another model selection.

- [ ] Run GREEN:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-config-selector.test.ts electron/main/agent/workflow-input-resolver.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Commit:

  ```bash
  git add apps/desktop/electron/main/agent/workflow-config-selector.ts apps/desktop/electron/main/agent/workflow-config-selector.test.ts
  git diff --cached --name-only
  git commit -m "feat: select configured workflow partial input"
  ```

## Task 7: 定义并验证参数收集续接决策工具

**Files:**

- Create: `apps/desktop/electron/main/agent/workflow-input-continuation.ts`
- Create: `apps/desktop/electron/main/agent/workflow-input-continuation.test.ts`

**Interfaces produced:**

```ts
export type WorkflowInputContinuationDecision =
  | { decision: 'continue'; input: Readonly<Record<string, unknown>> }
  | { decision: 'cancel' }
  | { decision: 'replace' }
  | { decision: 'clarify' }

export function workflowInputContinuationTool(
  modelSchema: Readonly<Record<string, unknown>>,
): ModelTool

export function parseWorkflowInputContinuationDecision(
  argumentsValue: unknown,
): WorkflowInputContinuationDecision
```

- [ ] Add failing tests for exact tool Schema and parser behavior. The tool has the fixed name `workflow_input_continuation`, requires `decision`, allows `input` only for `continue`, disallows additional properties, and embeds the current collection's permissive model Schema.

- [ ] Add tests that reject malformed JSON values, missing `input` on continue, `input` on other decisions, invalid decision strings, unknown patch fields, and runtime-bound patch fields. These failures map to `MODEL_PROVIDER_REQUEST_FAILED` and never count as user no-progress.

- [ ] Add prompt-policy tests for four deterministic meanings:

  ```text
  continue = 本条消息是对当前追问的回答，只提取本条明确参数；只有用户明确说“沿用/同上/刚才的”时才可读取被明确引用的历史值
  cancel = 用户明确取消当前工作流
  replace = 用户明确提出独立的新请求
  clarify = 无法确定继续还是替换
  ```

  Add policy assertions that the model may normalize only unambiguous representations such as `PDF` to `pdf` or an explicit Chinese calendar date to `YYYY-MM-DD`; multiple reasonable business choices must produce `clarify` or an omitted field, never a guess.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-input-continuation.test.ts --config vitest.node.config.ts
  ```

- [ ] Implement the tool, fixed system policy string, and strict parser. Parser may call the same partial patch validation seam as Task 6 but must not access persistence or execution.

- [ ] Run GREEN:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-input-continuation.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Commit:

  ```bash
  git add apps/desktop/electron/main/agent/workflow-input-continuation.ts apps/desktop/electron/main/agent/workflow-input-continuation.test.ts
  git diff --cached --name-only
  git commit -m "feat: define workflow input continuation tool"
  ```

## Task 8: 接入首次参数解析，禁止未就绪输入预留执行

**Files:**

- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-tool-executor.ts`
- Modify: `apps/desktop/electron/main/agent/workflow-tool-executor.test.ts`

**Dependency change:**

```ts
export interface AgentOrchestratorDependencies {
  workflowInputCollections: Pick<WorkflowInputCollectionsRepository,
    'createPending' | 'getPending' | 'updatePending' | 'transition'>
  timeZone?: () => string
}
```

- [ ] Extend the orchestrator test harness with an in-memory CAS-faithful `workflowInputCollections` fake. Keep the fake's behavior aligned with the SQLite repository, including one pending collection per conversation and terminal clearing.

- [ ] Add failing ordinary-workflow integration tests:

  - a complete tool call takes the existing direct prepare/approval/execution path and creates no collection;
  - an incomplete tool call persists a pending collection and returns deterministic assistant questions;
  - `executions.reserve`, `executions.startReserved`, policy approval, execution record creation, and budget consumption are all untouched while `needs_input`;
  - invalid supplied values are not persisted and ask only for their correction;
  - parameter values do not appear in the tool-error exchange, emitted status error, or diagnostics fixture;
  - runtime bindings derive `currentDate` from Main's clock/timezone boundary, `currentUser` from `active.userId`, and attachment indexes from `active.attachmentBindings.map(binding => binding.attachmentIndex)`;
  - a required attachment binding with no current attachments asks the user to attach files and never accepts a model-supplied index.
  - a natural request with no matching workflow retains ordinary answer/knowledge fallback;
  - an explicit named but inapplicable workflow returns a clear unsupported response without claiming execution;
  - existing permission approval is still requested only after the resolved input is ready.

- [ ] Run the narrow failing tests by their exact names:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/agent-orchestrator.test.ts --config vitest.node.config.ts -t "collects incomplete ordinary workflow input|keeps complete ordinary workflow direct|does not reserve incomplete workflow input"
  ```

- [ ] In `prepareTool()`, after intent/config selection and before `workflowTools.prepare()`, resolve the current partial input. For ordinary workflows use `candidate.inputContract.originalSchema`; for configured workflows use the selected item Schema and wrap the final ready value as `{ key, input }` only after resolution.

- [ ] Extend `WORKFLOW_AGENT_POLICY` with a compact extraction contract: emit only values explicit in the current message or explicitly referenced history, allow only unambiguous normalization, submit an empty partial object when required values are missing, and never infer a business choice or personal value. Keep `no_match` reserved for intent mismatch.

- [ ] Format `current-date` with `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })`, where `timeZone` is `dependencies.timeZone?.()` or the application runtime's resolved time zone. Tests inject `Asia/Shanghai` and a fixed `now`; do not rely on the test host's ambient time zone.

- [ ] On `needs_input`, create a pending collection containing only accepted explicit partial input and metadata-only diagnostics, append questions as ordinary assistant text, and terminalize the chat run as `completed`. Do not append a raw tool error containing arguments.

- [ ] On `ready`, pass the exact resolved input to `WorkflowToolExecutor.prepare()`. Keep Executor's final `validateWorkflowInput()` call unchanged in authority; adjust its input types or tests only as needed to make “ready-only caller” explicit.

- [ ] Generate collection identity from immutable Main data:

  ```ts
  {
    workflowId: candidate.workflow.id,
    workflowVersion: candidate.workflow.version,
    source: candidate.workflow.runtimeIdentity.source,
    buildHash: candidate.workflow.codeSha256,
    configKey: selectionKey,
    schemaFingerprint: contract.schemaFingerprint,
  }
  ```

- [ ] Set initial `consecutiveNoProgress` from the Resolver result and `expiresAt = now + 86_400_000`. A malformed model tool call must not create a row.

- [ ] Run GREEN plus existing execution regressions:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/agent-orchestrator.test.ts electron/main/agent/workflow-tool-executor.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Confirm these four paths were clean at Task 8 start, then stage them as complete files and inspect the staged diff. If any became dirty outside Tasks 1–7, leave that path unstaged:

  ```bash
  git add apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts apps/desktop/electron/main/agent/workflow-tool-executor.ts apps/desktop/electron/main/agent/workflow-tool-executor.test.ts
  git diff --cached --stat
  git diff --cached
  git commit -m "feat: collect incomplete workflow input"
  ```

## Task 9: 接入跨轮续接、取消、替换和失效状态机

**Files:**

- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

- [ ] Add failing integration tests for every pending continuation branch:

  - `continue` merges a valid patch, CAS-updates the row, renews expiry, and executes when ready;
  - `continue` with repeated/unknown/invalid data increments no-progress without renewing expiry;
  - the third consecutive no-progress reply transitions to `cancelled`, clears partial input, and explains cancellation;
  - `cancel` transitions atomically to `cancelled` and does not route or execute;
  - `clarify` leaves the row unchanged and asks whether to continue or replace;
  - `replace` cancels the row and routes the same current user message exactly once;
  - a second replacement attempt in one turn fails closed instead of recursively rerouting;
  - `ready` transitions the row to `resolved` before `WorkflowToolExecutor.prepare()`;
  - stale CAS returns safe `CONFLICT` and does not execute;
  - workflow id/version/source/build hash/config key/fingerprint mismatch transitions to `invalidated`, clears partial input, and asks for a new request;
  - an expired lazy read cannot be continued;
  - an approval denial or later execution failure does not reopen a resolved row;
  - a pending collection forces only the continuation tool and cannot feed two workflow tools.

- [ ] Add restart-shaped tests by constructing a second `AgentOrchestrator` over the same repository fake after the first run creates pending state. The second instance must retrieve exact workflow identity and continue without relying on in-memory state from the first instance.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/agent-orchestrator.test.ts --config vitest.node.config.ts -t "continues persisted workflow input|cancels workflow input collection|replaces workflow input collection|invalidates changed workflow input|cancels after three no-progress replies"
  ```

- [ ] At run setup, call `getPending(conversationId, now)` before ordinary workflow routing. Resolve its exact candidate from the eligible catalog by identity. For configured collections, call `inspectWorkflowConfig()` then `inspectWorkflowConfigItem(config, configKey)`; never rerun model config selection during recovery.

- [ ] Compare every identity component and the newly compiled fingerprint. On mismatch, CAS-transition to `invalidated`, append a value-free explanation, and complete the chat run without routing the current message.

- [ ] For a valid pending collection, replace normal offered tools with `workflow_input_continuation`, set `toolChoice` to that function, and include deterministic policy plus current questions. Do not include persisted partial values in the prompt. Normal conversation history may remain available only for an explicit historical reference in the current message; the policy forbids silently copying an unreferenced historical name, date, address, or other personal value.

- [ ] Handle decisions with a per-run `workflowInputReroutes` counter capped at 1. `replace` terminalizes the old row first, then initializes ordinary catalog routing using the same current message. `clarify` must not increment no-progress.

- [ ] After Resolver `needs_input`, use CAS `updatePending`; accepted progress resets counter and expiry, while no progress preserves expiry. At count 3, transition instead of update. After `ready`, transition to `resolved` before calling the Executor.

- [ ] Preserve multi-workflow serial behavior: once a ready workflow completes, the existing tool loop may select a later workflow; never create a second pending row until the first is terminal.

- [ ] Run GREEN and broad Agent regression:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/agent-orchestrator.test.ts electron/main/agent/workflow-tool-loop.test.ts electron/main/agent/workflow-router.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Confirm the two Agent paths contain only Task 8–9 changes, then commit them:

  ```bash
  git add apps/desktop/electron/main/agent/agent-orchestrator.ts apps/desktop/electron/main/agent/agent-orchestrator.test.ts
  git diff --cached
  git commit -m "feat: continue workflow input across turns"
  ```

## Task 10: 应用层装配和启动过期清理

**Files:**

- Modify: `apps/desktop/electron/main/application.ts`
- Modify: `apps/desktop/electron/main/application.test.ts`
- Modify: `apps/desktop/electron/main/database/client.ts`
- Modify: `apps/desktop/electron/main/database/database.test.ts`

- [ ] Inspect and preserve the user's existing application changes:

  ```bash
  git diff -- apps/desktop/electron/main/application.ts apps/desktop/electron/main/application.test.ts apps/desktop/electron/main/database/client.ts apps/desktop/electron/main/database/database.test.ts
  ```

- [ ] Add failing application tests asserting:

  - the real `chatDatabase.workflowInputCollections` repository is supplied to `AgentOrchestrator`;
  - application startup calls `expirePending(now)` once and clears stale partial values;
  - a repository cleanup failure does not start workflow execution and surfaces through existing safe startup/error handling;
  - app DB clearing/deleting conversations still cascades local collection rows;
  - user-cache and sync fixtures contain no `workflow_input_collections` table or payload field.

- [ ] Run RED:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/application.test.ts electron/main/database/database.test.ts --config vitest.node.config.ts -t "workflow input collection|expires stale workflow input"
  ```

- [ ] Expose the new repository from `openAppDatabase()` through the existing `...repositories` spread. At the application composition root, run one startup cleanup after migrations and before accepting Agent runs, then pass the repository into the orchestrator dependency object.

- [ ] Do not add an IPC method, preload bridge method, shared Renderer contract, or cloud/user-cache migration. Confirm this with a repository search:

  ```bash
  rg -n "workflowInputCollections|workflow_input_collections" apps/desktop/electron/preload apps/desktop/src apps/desktop/resources/user-cache-migrations apps/desktop/electron/main/database/user-data packages/shared/src/desktop-api.ts packages/shared/src/events.ts
  ```

  Expected: no matches outside tests that explicitly assert absence.

- [ ] Run GREEN:

  ```bash
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/application.test.ts electron/main/database/database.test.ts electron/main/agent/agent-orchestrator.test.ts --config vitest.node.config.ts
  pnpm --filter @autoforge/desktop typecheck
  ```

- [ ] Commit only paths that were clean at Task 10 start. In the current baseline, keep `application.ts` and `application.test.ts` unstaged because they already contain user changes:

  ```bash
  git add apps/desktop/electron/main/database/client.ts apps/desktop/electron/main/database/database.test.ts
  git diff --cached
  git commit -m "feat: wire workflow input collection lifecycle"
  ```

## Task 11: 升级内置示例和开发文档

**Files:**

- Modify: `examples/browser-search-baidu/manifest.json`
- Modify: `examples/browser-search-baidu/workflow.json`
- Modify: `examples/city-affairs/manifest.json`
- Modify: `examples/city-affairs/workflow.json`
- Modify: `examples/universal-file-converter/manifest.json`
- Modify: `examples/universal-file-converter/workflow.json`
- Modify: `WORKFLOW_DEVELOPMENT_BEST_PRACTICES.md`
- Modify: `CONTEXT.md`
- Modify: `docs/adr/0001-separate-model-and-execution-workflow-input-schemas.md`
- Modify: `docs/superpowers/specs/2026-09-01-workflow-input-resolution-design.md`

- [ ] Inspect all pre-existing example diffs before editing. These six JSON files already contain user changes:

  ```bash
  git diff -- examples/browser-search-baidu/manifest.json examples/browser-search-baidu/workflow.json examples/city-affairs/manifest.json examples/city-affairs/workflow.json examples/universal-file-converter/manifest.json examples/universal-file-converter/workflow.json
  ```

- [ ] Add or update existing manifest validation tests before modifying examples. Assert every built-in manifest validates and representative fields expose useful `title` and `description`. Add one safe binding example only where it matches actual workflow behavior: file attachment indexes may use `x-autoforge-binding: attachments`; do not add decorative bindings that change a workflow's current input contract.

- [ ] Run the relevant tests and confirm RED only for missing documentation/example metadata:

  ```bash
  pnpm --filter @autoforge/workflow-schema test
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/workflows/registry.test.ts --config vitest.node.config.ts
  ```

- [ ] Add field `title` and concise `description` to built-in input properties without renaming fields or changing requiredness. Keep paired `manifest.json` and `workflow.json` copies semantically aligned.

- [ ] Update the workflow development guide with:

  - strict execution Schema versus permissive model projection;
  - supported bindings and exact value shapes;
  - `personal` behavior and `secret` rejection;
  - default and patch precedence;
  - interactive reliable subset and fail-closed features;
  - a complete JSON example with no real personal or secret values.

- [ ] Reconcile `CONTEXT.md`, ADR, and approved spec with actual exported names and behavior. Change design wording only where implementation proved a necessary detail; record that detail explicitly rather than silently diverging.

- [ ] Run GREEN:

  ```bash
  pnpm --filter @autoforge/workflow-schema test
  pnpm --filter @autoforge/workflow-schema typecheck
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/workflows/registry.test.ts electron/main/agent/workflow-input-resolver.test.ts --config vitest.node.config.ts
  ```

- [ ] Commit only paths that were clean at Task 11 start. The six example JSON files are already dirty in the current baseline, so keep their metadata changes unstaged and commit only clean documentation paths:

  ```bash
  git add WORKFLOW_DEVELOPMENT_BEST_PRACTICES.md CONTEXT.md docs/adr/0001-separate-model-and-execution-workflow-input-schemas.md docs/superpowers/specs/2026-09-01-workflow-input-resolution-design.md
  git diff --cached
  git commit -m "docs: explain workflow input resolution"
  ```

## Task 12: 全量验证、隐私审计和最终代码评审

**Files:**

- Review: all files changed by Tasks 1–11
- Modify only when a failing test or review finding directly requires it

- [ ] Run targeted feature suites first:

  ```bash
  pnpm --filter @autoforge/workflow-schema test
  pnpm --filter @autoforge/workflow-sdk test
  pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/agent/workflow-input-schema.test.ts electron/main/agent/workflow-input-resolver.test.ts electron/main/agent/workflow-input-continuation.test.ts electron/main/agent/workflow-catalog.test.ts electron/main/agent/workflow-config-selector.test.ts electron/main/agent/workflow-tool-executor.test.ts electron/main/agent/agent-orchestrator.test.ts electron/main/database/workflow-input-collections.test.ts electron/main/database/database.test.ts electron/main/application.test.ts --config vitest.node.config.ts
  ```

  Expected: all exit 0. If an unrelated pre-existing failure appears, capture its exact test name and verify it also fails on the pre-feature base before classifying it as unrelated.

- [ ] Run type, lint, and complete tests:

  ```bash
  pnpm typecheck
  pnpm lint
  pnpm test
  ```

  Do not run a headed browser. If the full suite requires a headed mode, stop that command and report the remaining manual authorization requirement.

- [ ] Audit forbidden data flow and scope:

  ```bash
  rg -n "partialInput|partial_input_json|toolArguments|arguments:" apps/desktop/electron/main/agent apps/desktop/electron/main/database
  rg -n "workflowInputCollections|workflow_input_collections" apps/desktop/src apps/desktop/electron/preload apps/desktop/resources/user-cache-migrations apps/desktop/electron/main/database/user-data packages/shared/src/desktop-api.ts packages/shared/src/events.ts
  rg -n "credential:|x-autoforge-sensitive.*secret|provider.*credential" apps/desktop/electron/main/agent packages/workflow-schema examples
  ```

  Review every first-command match to ensure values only cross resolver/repository boundaries and are never logged. The second command must have no production matches. The third may match rejection tests/docs but no binding implementation.

- [ ] Verify state and execution invariants with focused tests or add a missing test before claiming completion:

  ```text
  one pending per conversation
  pending never reserves or creates execution
  resolved transition occurs before prepare
  every terminal state clears partial input
  no-progress does not extend expiry
  replacement reroutes once
  configured missing input is needs_input, not no_match
  final Executor validation remains enabled
  ```

- [ ] Review the final diff against the approved spec and existing user changes:

  ```bash
  git status --short
  git diff --stat c63442f
  git diff c63442f -- apps/desktop/electron/main/agent apps/desktop/electron/main/database apps/desktop/resources/migrations packages/workflow-schema packages/workflow-sdk packages/shared/src/errors.ts examples WORKFLOW_DEVELOPMENT_BEST_PRACTICES.md CONTEXT.md docs/adr docs/superpowers/specs
  ```

  Confirm every changed line traces to an approved requirement and no unrelated user file is staged.

- [ ] Invoke `superpowers:requesting-code-review` and review both axes: repository standards and approved spec. Fix only verified findings, rerun the smallest affected tests, then rerun `pnpm typecheck` and `pnpm lint`.

- [ ] Invoke `superpowers:verification-before-completion`. Record exact command outcomes in the final response, clearly separating feature failures from unrelated baseline failures.

- [ ] If review fixes required code changes only in paths that were clean before the review, commit them as a focused final commit. Leave fixes in pre-existing dirty paths unstaged and report them:

  ```bash
  git diff --cached
  git commit -m "fix: close workflow input resolution review gaps"
  ```

  If no changes are required, do not create an empty commit.

## Acceptance Matrix

| Requirement | Primary implementation | Primary verification |
| --- | --- | --- |
| Arbitrary parameter names/counts | Tasks 2, 3, 5 | schema, resolver, catalog tests |
| Explicit partial extraction only | Tasks 5–9 | catalog, selector, continuation, Agent tests |
| Strict authoritative validation | Tasks 2, 3, 8 | resolver and Executor tests |
| Defaults and three runtime bindings | Tasks 1–3, 8 | metadata and resolver tests |
| Personal redaction / secret rejection | Tasks 1, 3, 12 | schema, resolver, audit search |
| Durable one-per-conversation collection | Task 4 | migration/repository tests |
| Restart recovery and exact identity | Task 9 | second-orchestrator integration test |
| Cancel/replace/clarify/no-progress | Tasks 7, 9 | continuation and Agent tests |
| 24-hour expiry | Tasks 4, 9, 10 | repository, Agent, application tests |
| Config item missing input is needs_input | Tasks 6, 8 | selector and Agent tests |
| No early reserve/permission/budget | Task 8 | reserve and policy spies |
| Local-only, no Renderer/cloud sync | Tasks 4, 10, 12 | absence tests and audit search |
| Existing complete workflows compatible | Tasks 5, 8, 11 | catalog, Agent, registry tests |
| Multi-workflow serial execution | Task 9 | Agent tool-loop integration test |
