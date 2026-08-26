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
