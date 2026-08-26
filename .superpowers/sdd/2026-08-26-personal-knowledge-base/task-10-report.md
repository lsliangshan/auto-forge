# Task 10 Report: Verification, privacy, and fail-closed release gates

## Status

Task 10 is implemented and verified on the current macOS arm64 host. Repository-local and synthetic evidence remains explicitly ineligible for the approved Recall/grounding/processing/performance acceptance gates. No real CloudBase, PostgreSQL, PG Storage, TokenHub, chat provider, KMS, production entitlement key, or external environment was accessed or mutated.

## Implementation

- Added a pure Main-side release assessment contract. It requires the approved corpus, every published correctness threshold, the approved performance profile, CloudBase pre-production/authorization, TokenHub consent/revocation, chat-provider disclosure, production entitlement key and signer, internal telemetry review, and all three packaged platforms. Missing, non-finite, or near-threshold evidence produces explicit blockers. Beta and cloud can become true only together after every gate passes.
- Added immutable production evidence defaults with every approved/external/platform field false. Existing `PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS` remains empty; no key, signer, feature flag, or kill-switch default was enabled.
- Added payload-free retrieval, grounding, processing, and percentile evaluators. Reports contain only case IDs, counts, rates, and timings. They never retain query, snippet, source text, filename, local path, signed URL, credential, or key material, and always return `fixtureClass: synthetic_local` plus `officialAcceptanceEligible: false`.
- Added a real encrypted local harness. It creates two per-user cipher databases, inserts 10,000 generated chunks, runs real FTS5 retrieval, computes Recall@8 and p95, proves the other user returns zero results, scans encrypted artifacts before and after WAL checkpoint for a runtime-random sentinel, and independently evaluates exact Unicode-sentence grounding/no-evidence behavior.
- The processing harness executes TXT, Markdown, HTML, a generated text-layer PDF, and the package's safe DOCX fixture through the real parsers. It does not count hard-coded success values.
- Expanded the real Electron smoke across Renderer -> Preload -> validated IPC -> Main -> restricted parser -> encrypted persistence. It now covers durable import acknowledgement, ready publication, strict conversation selection, local chat retrieval, visible grounded citation, controlled source preview, ZIP export, recycle, immediate purge, visible empty state, and cloud-disabled degradation. Its stdout is payload-free.
- The post-review smoke no longer constructs a `KnowledgeService`, assistant message, or citation resolver in test code. It registers `createApplicationRuntime(...).services`, sends from the rendered composer, traverses Application -> AgentOrchestrator -> deterministic provider double -> real local retrieval, intentionally submits one unsupported material claim, accepts the single repaired claim, verifies the durable assistant row, and invokes the Application-owned citation resolver through production IPC. The controlled Main entitlement and server kill state is then closed before asserting cloud degradation. The export assertion parses the ZIP end record, central directory, local headers, entry count, `manifest.json`, and the expected original entry.
- Made smoke-runner tests independent of process cwd by anchoring their scripts/source paths at `import.meta.url`. This was required for the repository-root full test runner, while preserving the child-tree timeout and parent-owned plaintext cleanup checks.
- Added privacy/data-flow disclosure and an explicit release-gate document covering CloudBase Shanghai, TokenHub Guangzhou, selected chat providers, purpose, consent, retention, export/delete, membership expiry, degraded modes, current-host evidence, and external gates.
- Added `pnpm --filter @autoforge/desktop verify:knowledge-local` as the repeatable local security/relevance/grounding/processing/performance command.

## Strict TDD evidence

### Fail-closed release assessment

RED:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/release-gates.test.ts
```

Failed before implementation because `./release-gates.js` did not exist; one suite failed and no tests executed.

GREEN: the same command passed 4/4. It covers synthetic/current-host evidence rejection, exact threshold near-misses, the complete approved positive set, and production defaults closed.

### Payload-free evaluation

RED:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/release-evaluation.test.ts
```

Failed before implementation because `./release-evaluation.js` did not exist.

GREEN: the same command passed 3/3, covering top-eight truncation, independent Unicode sentence/citation support, no-evidence refusal, supported-processing denominator, nearest-rank p95, and payload absence.

### Real local harness

Initial RED:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/knowledge/release-harness.test.ts
```

Failed before implementation because `./release-harness.js` did not exist.

After the initial security/retrieval implementation, the test passed with 10,000 real encrypted FTS chunks. A later processing-hardening RED changed the required supported formats from three to five and failed with `readyCount: 3` versus `5`. The first real five-format run remained RED at 4/5 because the DOCX case returned `PARSER_MALFORMED_DOCUMENT`.

Systematic root cause: the harness passed Node's pooled `Buffer` from `readFile` directly, while the real parser boundary receives a normal `Uint8Array` from WebCrypto. `Buffer.slice().buffer` therefore exposed the pool instead of the exact DOCX bytes. Converting the fixture to an ordinary `Uint8Array` made the harness match the real boundary. GREEN passed 5/5 formats with no production parser change.

### Full Electron lifecycle smoke

RED:

```text
pnpm --filter @autoforge/desktop smoke:knowledge-ui
```

The prior smoke reached ready and restored selection but failed the new terminal assertion because its call trace lacked `searchSnapshot`, `previewCitation`, `exportBase`, `recycleDocument`, and `purgeDocument`.

GREEN: the final command rebuilt production Main/Preload/Renderer/workers and emitted:

```json
{"ok":true,"importedStatus":"parsing","persistedSelectionCount":0,"persistedKnowledgeMode":"strict","calls":["importDocument","updateConversationSelection","updateConversationSelection","searchSnapshot","previewCitation","exportBase","recycleDocument","purgeDocument"],"citationPreview":"available","exportCompleted":true,"deleteCompleted":true,"cloudAvailable":false}
```

The zero selection count is expected after recycle removes the purged base from the conversation selection. The non-fatal macOS `TASK_SUPPRESSION_POLICY` warning occurred after the success marker and exit 0.

### Root-runner portability

RED: the first repository-root `pnpm test` ran 3,164 tests and exposed three smoke-runner failures in addition to the known baseline. All three resolved `process.cwd()` relative to the repository root instead of `apps/desktop`, causing missing runner and KnowledgeService paths.

GREEN:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/e2e/knowledge-smoke-runner.test.ts
```

Passed 3/3 from the repository root. The test derives the desktop directory from `import.meta.url`; no production runner behavior changed.

## Independent-review fix round 1/5

The review reported Critical 0 / Important 3 / Minor 1. This round closes all four reported items without enabling a production gate.

### Strict parsing and no-evidence scoring

RED:

```text
pnpm exec vitest run apps/desktop/electron/main/knowledge/release-evaluation.test.ts apps/desktop/electron/main/knowledge/release-gates.test.ts
```

Result: 2 files failed; 6 failed / 7 passed. A refusal with one material claim incorrectly counted as correct; string `false`, rate `2`, incomplete packaged-platform evidence, and an unknown field were accepted or mapped to ordinary blockers; results were mutable.

GREEN: the same command passed 13/13. `assessKnowledgeRelease(unknown)` now uses strict runtime schemas, finite `[0,1]` rates, complete strict nested platform evidence, strict top-level fields, an explicit immutable `malformed_release_evidence` blocker, and no throwing/release path for malformed input. No-evidence correctness now additionally requires zero material claims.

### Production admission AND

RED:

```text
pnpm exec vitest run apps/desktop/electron/main/knowledge/knowledge-service.test.ts -t "ANDs Main release admission"
```

Result: 1 failed / 63 skipped. An otherwise valid member exposed beta/cloud/knowledge-tool as true despite a closed release assessment.

GREEN: the same command passed 1/1. The final version uses an actual Ed25519 Signer -> Verifier member envelope plus an authoritative server response. The server call occurs, but Main release admission independently denies knowledge-tool and cloud use and masks exposed entitlement capability flags.

Application wiring RED:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/application.test.ts -t "passes a Main-owned approved release assessment"
```

Result: 1 failed / 161 skipped; complete approved test evidence was not passed to KnowledgeService and all three capability flags remained false.

GREEN:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/application.test.ts -t "release (assessment|defaults)"
```

Result: 2 passed / 161 skipped. Application now assesses one Main-owned evidence object once and passes an immutable assessment to KnowledgeService. With the option absent, repository production evidence remains all false, and a valid member entitlement still cannot enable beta, cloud, or the knowledge tool. Test-only complete evidence can open the deterministic harness without changing production defaults.

### Authentic Electron Application/Agent smoke

RED:

```text
pnpm exec vitest run apps/desktop/electron/e2e/knowledge-ui-smoke-source.test.ts
```

Result: 1/1 failed because the smoke did not use `createApplicationRuntime`, contained a test-owned message list and citation resolver, and directly constructed KnowledgeService.

GREEN: the same source-composition test passed 1/1 after those seams were removed. The real smoke then passed:

```text
pnpm --filter @autoforge/desktop smoke:knowledge-ui
```

It rebuilt production Main/Preload/Renderer/workers, loaded native modules under Electron 43.1.1, exited 0, and emitted only boolean lifecycle evidence:

```json
{"ok":true,"rendererChatSend":true,"applicationAgentRepair":true,"durableCitationPreview":true,"exportZipValidated":true,"deleteCompleted":true,"cloudAvailableAfterKill":false}
```

No real CloudBase or external provider was contacted. The cloud Function port and model provider were deterministic in-process doubles; the network port throws on every attempted fetch.

### Fix-round verification

- `pnpm --filter @autoforge/desktop verify:knowledge-local`: 7 files, 271/271 passed. Latest current-host synthetic measurement: 10,000 chunks / 40 samples / p95 0.801709 ms; Recall@8 20/20; cross-user count 0; encrypted sentinel matches 0; processing 5/5. This remains acceptance-ineligible synthetic evidence.
- focused Application/Knowledge/release/smoke-source run: 5 files, 240 passed plus exactly the known unrelated context-summary `CONTEXT_LIMIT_EXCEEDED` failure in Application; no new failure.
- `node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/agent/agent-orchestrator.test.ts -t "Agent knowledge grounding"`: 37/37 passed.
- `pnpm typecheck`: all four typed workspace projects passed.
- `pnpm lint --quiet`: exit 0.
- `git diff --check`: exit 0.

## Measurements and verification

Latest repository-root full test harness measurement:

- encrypted artifact sentinel matches before plus after checkpoint: 0;
- cross-user result count: 0;
- synthetic Recall@8: 20/20 = 1.0;
- independent citation support / grounded answer / correct no-evidence rates: 1.0 / 1.0 / 1.0;
- valid synthetic/safe processing: TXT, Markdown, HTML, PDF, DOCX = 5/5;
- local encrypted FTS: 10,000 chunks, 40 samples, p95 0.921125 ms.

These measurements are current-host synthetic evidence only. They do not satisfy or modify the approved corpus/profile thresholds in the design spec.

Verification results:

- `pnpm --filter @autoforge/desktop verify:knowledge-local`: 7 files, 265/265 passed. The final focused measurement was 0.851708 ms p95.
- `node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/e2e/knowledge-smoke-runner.test.ts electron/main/database/native-packaging.test.ts`: 2 files, 11/11 passed.
- `pnpm typecheck`: all four typed workspace projects passed after the final implementation.
- `pnpm lint --quiet`: exit 0.
- `pnpm dist:dir`: build, native preparation, macOS arm64 directory package, and packaged runtime probe passed. The packaged app loaded proxy agents, both SQLite drivers, encrypted reopen, FTS5 trigram, `temp_store=MEMORY`, and the workflow compiler under Electron 43.1.1. Notarization was skipped because notarization options were unavailable.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui`: full real local lifecycle passed with the payload-free success object above.
- repository-root `pnpm test`: 113 files passed and one file had the single recorded baseline; 3,163 passed / 1 failed (3,164 total). The sole failure is `electron/main/application.test.ts > createApplicationRuntime > bills real context-summary streams through the Application-supplied provider snapshot`, which emits and ends failed with exactly `CONTEXT_LIMIT_EXCEEDED` instead of completion.
- `git diff --check`: passed before report creation and will be rerun before commit.

## Files changed

- `apps/desktop/electron/main/knowledge/release-gates.ts`
- `apps/desktop/electron/main/knowledge/release-gates.test.ts`
- `apps/desktop/electron/main/knowledge/release-evaluation.ts`
- `apps/desktop/electron/main/knowledge/release-evaluation.test.ts`
- `apps/desktop/electron/main/knowledge/release-harness.ts`
- `apps/desktop/electron/main/knowledge/release-harness.test.ts`
- `apps/desktop/electron/e2e/knowledge-ui-smoke-main.ts`
- `apps/desktop/electron/e2e/knowledge-ui-smoke-source.test.ts`
- `apps/desktop/electron/main/application.ts`
- `apps/desktop/electron/main/application.test.ts`
- `apps/desktop/electron/main/knowledge/knowledge-service.ts`
- `apps/desktop/electron/main/knowledge/knowledge-service.test.ts`
- `apps/desktop/electron/e2e/knowledge-smoke-runner.test.ts`
- `apps/desktop/package.json`
- `docs/knowledge/personal-knowledge-base-privacy.md`
- `docs/knowledge/personal-knowledge-base-release-gates.md`
- this report

The controller-owned `progress.md` remains dirty and is excluded from this task's staging and commit.

## External gates and concerns

- CloudBase Shanghai PostgreSQL/RLS/PG Storage/user-JWT/concurrency, TokenHub Guangzhou, real chat-provider disclosure, real KMS signer/key rotation, and internal telemetry review were not configured or accessed. They remain external blockers.
- `PRODUCTION_KNOWLEDGE_ENTITLEMENT_TRUSTED_KEYS` and every production release-evidence field remain empty/false. Cloud, beta, and new Agent knowledge-tool admission remain fail-closed.
- macOS arm64 has current-host direct, real Electron smoke, and packaged-runtime evidence. macOS x64 and Windows x64 remain unverified release blockers; package contents are not treated as execution proof.
- The synthetic local metrics are intentionally not written into the approved design thresholds or production evidence. No spec safety limit was changed.
- macOS notarization remains an external packaging gate because the local directory package had no notarization options.
- The known unrelated context-summary billing test remains exactly the recorded `CONTEXT_LIMIT_EXCEEDED` baseline and was neither hidden nor attributed to knowledge code.

## Fix round 2: exclude smoke code from production packages

The prior smoke command wrote an executable bundle under `out/e2e`. Because the production builder admitted `out/**`, a stale copy could enter `app.asar` with the smoke-only approved release evidence and signing key. No production admission path opened, but the package boundary was incorrect.

### TDD RED / GREEN

RED, after adding a stale smoke entry containing only non-sensitive marker text to a temporary package fixture and applying electron-builder's real `app-builder-lib` `FileMatcher` to the repository configuration:

```text
pnpm exec vitest run apps/desktop/electron/main/package-content.test.ts
```

Result: 1/1 failed. The actual builder filter included both `out/main/index.js` and `out/e2e/knowledge-ui-smoke-main.js`.

Production/support changes were then kept narrow:

- the smoke bundle now writes to disposable `.e2e/main`, outside every production `out/**` input;
- the runner loads that new location;
- electron-builder explicitly excludes `out/e2e/**`, so a stale prior bundle cannot be admitted.

GREEN: the identical command passed 1/1. The real builder matcher admitted only the benign production entry, and the selected input bytes contained neither the all-true evidence marker nor `smoke-only-key`.

### Round-2 verification

- `node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/e2e/knowledge-smoke-runner.test.ts apps/desktop/electron/main/database/native-packaging.test.ts apps/desktop/electron/main/build-config.test.ts apps/desktop/electron/main/package-content.test.ts`: 4 files, 14/14 passed. The smoke-runner timeout diagnostics were expected negative-case output.
- `pnpm --filter @autoforge/desktop smoke:knowledge-ui`: exited 0 after rebuilding Main/Preload/Renderer/workers and bundling only to `.e2e/main`; the real Renderer -> Application -> Agent -> durable citation preview/export/delete lifecycle returned the same seven boolean success fields, including `cloudAvailableAfterKill:false`. No external service was available or contacted.
- `pnpm typecheck`: all four typed workspace projects passed.
- `pnpm lint --quiet`: exit 0.
- Actual `pnpm dist:dir` package inspection used `@electron/asar` after creating a current macOS arm64 directory package. The stale workspace `out/e2e/knowledge-ui-smoke-main.js` remained present as the regression condition, while all 25,236 `app.asar` entries contained zero `e2e`, `.e2e`, or `knowledge-ui-smoke` matches and the archive contained no `smoke-only-key` bytes. This is package-content proof, not cross-platform execution proof.

Round-2 files changed:

- `apps/desktop/electron-builder.yml`
- `apps/desktop/package.json`
- `apps/desktop/scripts/run-knowledge-ui-smoke.mjs`
- `apps/desktop/electron/main/package-content.test.ts`
- this report

The controller-owned `progress.md` remains dirty and excluded. No real CloudBase, TokenHub, provider, production entitlement key, or other external infrastructure was accessed. macOS x64, Windows x64, staging CloudBase/RLS/concurrency, real provider disclosure, KMS key rotation, internal telemetry review, and notarization remain external release gates.
