# Final context-budget fix report

## Scope and root cause

The final whole-branch review found that `AgentOrchestrator` relied on the initial `ConversationHistoryPort.prepare()` budget check only. Later provider decisions reused `active.messages` without applying `resolveChatInputBudget()` and `estimateRequestTokens()`. Knowledge exchanges also rebuilt every tool result from the cumulative `knowledgeEvidence` map, so repeated searches resent old snippets and could grow a continuation far beyond the selected model's 60% request budget.

This fix keeps the cumulative Main-owned evidence map for citation validation, but each knowledge tool result now owns only the evidence IDs newly admitted by that search. Before every Agent provider decision, Main estimates the complete request with the currently offered tools and current-media reserve. If necessary, it deterministically applies one Unicode-character prefix limit to every transient knowledge snippet while retaining every evidence ID and marking truncated snippets. If the request still cannot fit with identity-only knowledge payloads, the run fails with `CONTEXT_LIMIT_EXCEEDED` before another provider stream starts.

No CloudBase, TokenHub, external provider, entitlement signer, or other external service was accessed or enabled.

## Strict TDD evidence

RED, before production changes:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/agent/agent-orchestrator.test.ts -t 'bounds every knowledge continuation|fails closed before a knowledge continuation' --reporter=dot
```

Result: 2 failed / 228 skipped. The near-budget repeated-search request was estimated at 57,398 tokens against a 12,000-token budget. The impossible continuation incorrectly reached the provider and completed instead of failing closed.

GREEN, after the minimal implementation:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/agent/agent-orchestrator.test.ts -t 'bounds every knowledge continuation|fails closed before a knowledge continuation' --reporter=dot
```

Result: 2 passed / 228 skipped. The regression captures immutable request snapshots at provider-call time and proves:

- a near-budget history plus two searches returning eight maximum-size 4,000-character snippets never sends a request over the resolved 12,000-token budget;
- the first and second tool messages contain only their four newly admitted evidence IDs, while the cumulative map still validates citations from both searches;
- deterministic trimming retains every admitted evidence ID and explicitly marks truncated snippet data;
- an identity-only payload that cannot fit returns controlled `CONTEXT_LIMIT_EXCEEDED`, and the provider is called exactly once.

The existing history-order fixture used a 4,096-token model together with an audio reserve that already made its mocked `history.prepare()` output impossible under the real budget contract. Its context length was corrected to 32,000 so the test continues to verify history/media propagation without bypassing the new provider-boundary invariant.

## Verification

- Full Agent suite: 230/230 passed.
- Agent plus full Application suite: 392/393 passed. The sole failure was the recorded unrelated `createApplicationRuntime > bills real context-summary streams through the Application-supplied provider snapshot`, which still returns `CONTEXT_LIMIT_EXCEEDED` instead of completion.
- `pnpm typecheck`: all four typed workspace projects passed.
- `pnpm lint --quiet`: exit 0.
- `pnpm build`: shared/workflow packages and Electron Main, Preload, Renderer, and worker targets passed.
- Repository-root `pnpm test`: 115 files passed and one file contained only the recorded baseline; 3,176 passed / 1 failed (3,177 total). The exact failure remained the unrelated context-summary billing case above.
- `git diff --check`: passed.

## Files

- `apps/desktop/electron/main/agent/agent-orchestrator.ts`
- `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- this report

The controller-owned `progress.md` was not edited and is excluded from this fix commit.

## Round 1 remaining concern

Transient evidence may be reduced to very short prefixes under extreme but still feasible budgets. All evidence IDs remain visible, truncation is explicit, and support validation uses only the exact provider-visible prefix while the immutable cumulative Main copy supplies citation metadata. If even the identity-preserving exchange cannot fit, the provider is not called. The unrelated Task 6 durable `syncing` status Minor and every external release gate remain unchanged.

## Independent-review fix round 2/5: validate only visible evidence

The rereview found that prefix trimming changed the provider payload but strict support validation still read the full hidden `knowledgeEvidence` snippet. A provider could therefore cite a visible evidence ID and echo a sentence from the user question that existed only in an empty or removed suffix; Main would incorrectly accept it against data the provider did not receive.

The run now maintains two distinct states:

- `knowledgeEvidence` remains the immutable cumulative Main copy used for durable citation metadata and preview identity;
- `knowledgeVisibleEvidence` is rebuilt immediately before each provider decision from the exact snippets serialized in that request's tool messages and is the only input to strict claim-support proof.

Every retrim updates both the tool messages and their visible-evidence projection before streaming. Evidence IDs remain stable. An answer cannot cite an ID absent from the current request's visible map, and an exact sentence that was emptied or trimmed into a hidden suffix cannot support a claim.

RED, before the round-2 production change:

```text
node apps/desktop/scripts/run-vitest-electron.mjs run apps/desktop/electron/main/agent/agent-orchestrator.test.ts -t 'empty snippet|beyond the exact prefix|remains visible after prefix trimming' --reporter=dot
```

Result: 2 failed / 1 passed / 230 skipped. Main persisted both the claim backed only by an empty transmitted snippet and the claim present only beyond a transmitted prefix. The exact complete sentence that remained visible already passed and served as the positive control.

GREEN, after the minimal production change:

- The same three-case command passed 3/3.
- The complete five-case context-budget focus, including per-request limits and impossible continuation, passed 5/5.
- Full Agent suite: 233/233 passed.
- Full Application suite: 162 passed / exactly one recorded unrelated context-summary `CONTEXT_LIMIT_EXCEEDED` failure.
- Repository-root `pnpm test`: 115 files passed; 3,179 passed / 1 failed (3,180 total). The sole failure remained that same recorded Application baseline.
- `pnpm typecheck`: all four typed workspace projects passed.
- `pnpm lint --quiet`: exit 0.
- `pnpm build`: all shared/workflow packages and Electron Main, Preload, Renderer, and worker targets passed.
- `git diff --check`: passed.

The captured maximum-size request additionally asserts `snippetTruncated:true`, retains a complete non-BMP emoji across code-point-safe truncation, and contains no replacement character. No external system was accessed or enabled. The controller-owned `progress.md` remained untouched and is excluded from the commit.

## Remaining concerns after round 2

No context-budget Critical or Important concern remains in this implementation. The unrelated Task 6 durable `syncing` status Minor, the known Application context-summary baseline, and every external release gate remain unchanged.
