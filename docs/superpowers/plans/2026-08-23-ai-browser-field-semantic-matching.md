# AI Browser Field Semantic Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the active AI model to match a trusted user request to visible browser field labels without hard-coded semantic aliases or exposing candidate values before selection.

**Architecture:** `BrowserPageInspector` creates public label-only nodes plus run-local private field evidence. `AgentOrchestrator` validates that evidence, calls an isolated strict-tool semantic matcher through the frozen provider snapshot, and renders a value only when the model returns exactly one known candidate.

**Tech Stack:** TypeScript, Electron Main, CDP accessibility snapshots, Zod, Vitest, existing `trackProviderStream` billing.

**Spec:** `docs/superpowers/specs/2026-08-23-ai-browser-field-semantic-matching-design.md`

## Global Constraints

- No synonym dictionaries, embeddings, substring fallback, or hard-coded semantic equivalence rules.
- Candidate values remain in Main and are never included in matcher prompts or model-visible inspect results.
- Existing secret, hidden-control, identity-number, OTP, CAPTCHA, and token exclusions remain deterministic.
- Model failures and zero, multiple, duplicate, or unknown selections fail closed.
- Reuse the active run's frozen provider snapshot, selected model, cancellation signal, and provider-usage accounting.

---

### Task 1: Host-only structured field evidence

**Files:**
- Modify: `apps/desktop/electron/main/browser/browser-page-inspector.ts`
- Test: `apps/desktop/electron/main/browser/browser-page-inspector.test.ts`

**Interfaces:**
- Produces: `BrowserPrivateFieldEvidence { snapshotId, ref, label, value }` and `BrowserPageInspector.fieldEvidence(snapshotId)`.
- Consumes: existing `RefState`, `SafeCandidate`, snapshot identity, and static-field safety filters.

- [ ] Write tests proving `证件编号：202111127927` and `证件类型：身份证` create public label-only nodes while `fieldEvidence(snapshotId)` returns their values. Test that identity numbers, instructions, tokens, and hidden nodes remain blocked.
- [ ] Run `pnpm test apps/desktop/electron/main/browser/browser-page-inspector.test.ts -t "private field evidence"` and verify RED because the private API does not exist.
- [ ] Extend `SafeCandidate` and `RefState` with a host-only field value, omit it from `BrowserSemanticNode`, and add `fieldEvidence(snapshotId): readonly BrowserPrivateFieldEvidence[]`.
- [ ] Refactor structured static extraction to validate visibility, structure, bounds, and safety without comparing labels to user intent. Preserve typed date/value validation and blocked private shapes.
- [ ] Run `pnpm test apps/desktop/electron/main/browser/browser-page-inspector.test.ts` and verify GREEN.

### Task 2: Private evidence transport

**Files:**
- Modify: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.ts`
- Test: `apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts`

**Interfaces:**
- Consumes: `BrowserPageInspector.fieldEvidence(snapshotId)`.
- Produces: an internal inspect-success evidence property that is separate from public `data.snapshot`.

- [ ] Write tests asserting Main receives private evidence while `JSON.stringify(result.data)` contains labels but not values, and every evidence ref belongs to the returned snapshot.
- [ ] Run the focused test and verify RED because the executor has no private channel.
- [ ] Add a bounded readonly private evidence property to inspect success and populate it after inspection. Keep audit rows redacted.
- [ ] Run `pnpm test apps/desktop/electron/main/agent/browser-continuation-tool-executor.test.ts` and verify GREEN.

### Task 3: Isolated AI semantic matcher

**Files:**
- Create: `apps/desktop/electron/main/agent/browser-field-semantic-matcher.ts`
- Create: `apps/desktop/electron/main/agent/browser-field-semantic-matcher.test.ts`

**Interfaces:**
- Consumes: trusted request, bounded `{ id, label }[]`, frozen provider snapshot, model, IDs, usage repository, signal, `id`, and `now`.
- Produces: `{ matchingCandidateIds, usage? }` or a fail-closed empty result.

- [ ] Write tests for model-selected `证件号码` to `证件编号`, model-rejected `证件类型` to `证件号码`, and rejection of prose-only output, multiple tool calls, unknown IDs, duplicate IDs, malformed arguments, cancellation, and value leakage.
- [ ] Run `pnpm test apps/desktop/electron/main/agent/browser-field-semantic-matcher.test.ts` and verify RED because the module does not exist.
- [ ] Implement one isolated provider request with only the trusted request and `{id,label}` candidates. Require one strict `report_browser_field_matches` tool call with `{matchingCandidateIds: string[]}`.
- [ ] Use `trackProviderStream`, validate with Zod and the known-ID set, and fail closed for every invalid sequence.
- [ ] Run the matcher test file and verify GREEN.

### Task 4: Orchestrator integration

**Files:**
- Modify: `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Test: `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`

**Interfaces:**
- Consumes: validated private evidence plus `matchBrowserFieldLabels`.
- Produces: AI-selected, host-rendered answers with exactly-one uniqueness.

- [ ] Add failing orchestration tests for both user examples, multiple matches, unknown IDs, matcher failure, billing attribution, and absence of private values in regular tool messages and matcher prompts.
- [ ] Run the focused semantic tests and verify RED because `browserAnswer` still uses text overlap.
- [ ] Validate private evidence before public tool-result serialization. Replace `relevantEvidence` and `longestSharedText` with an async matcher call, add matcher usage to the active run, and render only one known selected candidate.
- [ ] Run focused tests and the complete `agent-orchestrator.test.ts` suite; verify GREEN for this feature and no browser regression.

### Task 5: Full verification

**Files:**
- Modify only if required by physical regression: `apps/desktop/tests/e2e/browser-continuation-fixture.ts`
- Modify only if required by physical regression: `apps/desktop/tests/e2e/browser-continuation.spec.ts`

**Interfaces:**
- Consumes: completed Main implementation.
- Produces: repository-level verification evidence.

- [ ] Run changed-file ESLint for inspector, executor, matcher, and orchestrator.
- [ ] Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- [ ] Run `pnpm test:e2e:browser-continuation` and verify semantic positive/negative cases plus existing browser behavior.
- [ ] Run `git diff --check`, inspect `git status --short`, and confirm no candidate values appear in logs, persistence, or model-visible tool results.
