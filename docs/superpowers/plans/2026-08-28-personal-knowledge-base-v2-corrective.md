# Personal Knowledge Base v2 Corrective Plan

**Date:** 2026-08-28

**Approved by user:** yes

**Binding spec:** `docs/superpowers/specs/2026-08-26-personal-knowledge-base-v2-design.md`

**Starting HEAD:** `6031dfb81bf8207ccb95249dabe9d3a8686336b4`

**Purpose:** Resolve the eight load-bearing residuals from the first whole-branch fix review without changing product scope.

## Global constraints

- Personal knowledge bases only. Preserve Main and UI enforcement of one local base and one active file for non-members.
- Preserve current v2 auth, user-data/outbox/revision/session/admission/logout/shutdown, Agent and browser/workflow behavior.
- Do not merge, rebase, or cherry-pick the old knowledge branch or the newer `origin/v2` commit.
- No real Provider, CloudBase, PostgreSQL, PG Storage or TokenHub request; no deployment, migration execution, feature opening, PR or merge.
- Production cloud kill switch remains closed. Staging-only metrics remain `unverified`.
- Every behavior change starts with a failing test. Each task receives independent review and fixes all Critical/Important findings before the next task.

## Task 1: Fail-closed grounding and mixed no-evidence output

**Files:**

- Modify `apps/desktop/electron/main/agent/knowledge-evidence.ts`
- Modify `apps/desktop/electron/main/agent/knowledge-evidence.test.ts`
- Modify `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify `apps/desktop/electron/main/knowledge/evaluation/corpus.json`

**Acceptance tests:**

- RED strict/mixed cases for `A项目工时100小时，B项目工时200小时` -> `A项目工时，200小时`, plus equivalent English and same-value/different-subject variants.
- A structurally field-like comma claim must either produce an anchored subject/relation/object tuple or fail closed. Zero parsed tuples must never make such a group supported.
- Preserve legitimate temporal/list/copula positives, including time values containing `:` and ordinary non-field comma sentences.
- RED mixed/no-evidence cases for forged complete markers and malformed/incomplete markers. Strip all knowledge marker material before returning `【一般信息】...`; never return raw forged syntax. An empty sanitized answer becomes the bounded insufficient response.
- Run Agent, evidence and evaluation suites; commit.

## Task 2: Bind security state to the full Agent and owner lifecycle

**Files:**

- Modify `apps/desktop/electron/main/application.ts`
- Modify `apps/desktop/electron/main/application.test.ts`
- Modify `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- Modify `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- Modify `apps/desktop/electron/main/knowledge/knowledge-service.ts`
- Modify `apps/desktop/electron/main/knowledge/knowledge-service.test.ts`
- Modify `apps/desktop/electron/main/knowledge/sync-service.ts`
- Modify `apps/desktop/electron/main/knowledge/sync-service.test.ts`

**Acceptance tests:**

- RED workflow -> approval -> resume -> knowledge-search case. The immutable admitted scope remains pinned through `awaiting_approval` and releases exactly once only at terminal completion, cancellation, deletion, owner invalidation or shutdown.
- Scope cleanup must not leak on denied approval, Provider error, cancellation or shutdown.
- RED concurrent revoke case: publish an in-memory owner/provider consent fence before the first await. A new ask started after revoke begins cannot read or send previously granted evidence. Re-grant advances the fence and permits only subsequently admitted runs.
- RED held-purge case through the public `KnowledgeService.invalidate()` boundary. Cloud sync and retention epochs advance synchronously before retirement/awaits; late callbacks cannot write receipts, mode changes or local projections. Drain covers the fenced operation.
- Preserve rejected-logout rebinding and same-UID entitlement refresh behavior from the prior fix.
- Run Application, Agent, KnowledgeService and SyncService suites; commit.

## Task 3: Make entitlement migration rollback data-preserving

**Files:**

- Modify `cloudbase/user-roles/migrations/0002_knowledge_entitlement.rollback.sql`
- Modify `cloudbase/user-roles/README.md`
- Modify `tests/cloudbase/user-role-handler.test.ts`
- Modify `tests/cloudbase/user-role-migration.test.ts`

**Acceptance tests:**

- RED contract proving rollback does not drop/truncate/delete `knowledge_entitlement` or accepted user data.
- Rollback may restore the previous function projection while retaining the additive column and its values for safe forward re-application.
- README lists the additive forward migration after the published base migration, verification order, and the data-preserving rollback sequence.
- Published base migration bytes remain identical to `origin/v2`; forward mirrors remain identical.
- Run migration/function syntax, mirror and rollback scans; commit.

## Task 4: Complete consented cloud recovery and cross-device materialization

**Files:**

- Modify `apps/desktop/electron/main/application.ts`
- Modify `apps/desktop/electron/main/knowledge/knowledge-service.ts`
- Modify `apps/desktop/electron/main/knowledge/knowledge-service.test.ts`
- Modify `apps/desktop/electron/main/knowledge/sync-service.ts`
- Modify `apps/desktop/electron/main/knowledge/sync-service.test.ts`
- Modify `apps/desktop/electron/main/knowledge/knowledge-schema.ts`
- Modify `apps/desktop/electron/main/knowledge/knowledge-schema.test.ts`
- Modify cloud client/contracts only where required by the materialized payload.

**Acceptance tests:**

- RED queued-generation case where the worker completes after the third poll. Persist retry/backoff state and recover publication on a later bind/sync/list/search cycle without a tight loop or duplicate upload.
- RED cross-device pull/snapshot cases. Materialize owner-scoped base/document/version/generation projections needed by list, admission and cloud retrieval instead of storing only opaque heads. Stale/zero cursors replace the snapshot atomically; incremental changes preserve sequence and tombstones.
- Cloud-only projections never claim a local object exists. Export/convert must download and verify content before publication.
- Reuse the existing authoritative `privacy_consents` purpose `cloud_sync`. No knowledge upload/publication/search occurs without the current accepted cloud-sync consent, even when entitlement/beta/kill-switch gates allow it. Revocation pauses new cloud work immediately while local management/retrieval remains available.
- Availability reports cloud available only when executable remote capabilities, entitlement/beta/kill switch and current cloud-sync consent all pass.
- Run service/sync/client/schema/Application and degradation tests; commit.

## Task 5: Isolate and bound the Cloud knowledge parser worker

**Files:**

- Modify `cloudbase/knowledge/worker/index.js`
- Modify `cloudbase/knowledge/worker/knowledge-worker.js`
- Create a dedicated parser-child entry under `cloudbase/knowledge/worker/`
- Modify `cloudbase/knowledge/worker/package.json`
- Modify `tests/cloudbase/knowledge-worker.test.ts`
- Modify worker migration/runbook only if the deployment entry changes.

**Acceptance tests:**

- RED never-settling parser case; a job settles to a bounded retry/terminal result before its lease expires and `runOnce()` returns.
- Parse untrusted bytes in a separate one-request process with scrubbed environment and no service-role, Storage or TokenHub credentials. The credentialed scheduler retains all network access and communicates only through bounded IPC frames.
- Enforce input bytes, DOCX expanded bytes/compression ratio, PDF pages, text bytes, block count, response bytes, memory and wall-time before or during accumulation, not only after complete parsing.
- Cancellation/timeout kills the parser process, closes IPC and zeroes source bytes. Parser crashes and malformed frames cannot settle a different lease.
- Preserve max-eight claims, two-chunk embedding slices, lease CAS/yield, transient retry max three, idempotency and Storage-before-metadata purge.
- Run worker/handler/migration tests, JS syntax/package resolution and leak scans; commit.

## Task 6: Whole corrective review, final verification and delivery

- Run a fresh whole-corrective independent review from `6031dfb` to final HEAD. Fix every Critical/Important finding under the corrective plan's normal per-task review loops.
- Invoke `superpowers:verification-before-completion`; personally run build, typecheck, lint, focused suites, full tests, evaluation, Electron smoke, 100-page benchmark, parser package smoke, migration/security scans and `git diff --check` on final HEAD.
- Reproduce and separate the recorded origin/v2 baseline failures where needed; no new/changed overlap may be waived.
- Invoke `superpowers:finishing-a-development-branch`; only after every release blocker is closed, push `codex/personal-knowledge-base-v2` and confirm the exact remote SHA with `git ls-remote`.
- Do not create a PR, merge, deploy, open the kill switch or delete either worktree/branch.
