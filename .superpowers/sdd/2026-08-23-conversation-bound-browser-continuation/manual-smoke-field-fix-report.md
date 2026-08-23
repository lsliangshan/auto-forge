# Beijing manual-smoke static-field fix report

## Scope and root cause

- Base: `1d461fdb2be4ab2a1cb350cf8225f6ad235646bb`.
- The reproducible Beijing detail field is one Accessibility `StaticText` node whose name contains both label and ISO date. It has no separate AX value.
- `BrowserPageInspector` previously emitted values only for form/value roles. `AgentOrchestrator` intentionally records evidence only from nodes with a non-empty `value`, so the visible field produced zero Main-owned evidence and the final answer was the safe uncertainty response.
- The fix is confined to the Inspector projection plus tests/fixture. `AgentOrchestrator` production behavior did not need to change.

## RED evidence

1. Inspector and Orchestrator focused RED:

   ```text
   node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
     electron/main/browser/browser-page-inspector.test.ts \
     electron/main/agent/agent-orchestrator.test.ts

   Test Files  2 failed (2)
   Tests       7 failed | 181 passed (188)
   ```

   The two real static-date cases retained the combined name with no value. The Orchestrator integration returned `无法从已绑定网页中唯一确认请求的字段`; two static values were absent as structured evidence. The same run also proved that relevant prompt injection, a Chinese-colon filesystem path, and a credential-labelled field crossed the old name-only boundary.

2. Real Electron fixture RED after replacing the readonly form input with a static `div`:

   ```text
   1 failed; 18 did not run
   getByText('工作居住证有效期：2028-06-30') -> element(s) not found
   ```

3. Security mutation RED added during review:

   ```text
   BrowserPageInspector > does not turn colon-bearing prose or prompt injection into field evidence
   1 failed | 51 skipped
   ```

   A relevant label followed by an unpunctuated explanatory sentence was initially projected as a value. A conservative prose-cue rejection was added before final verification.

4. URL/credential branch RED after temporarily removing the new guards:

   ```text
   BrowserPageInspector > drops a relevant-looking static field with a $case value
   2 failed | 4 passed | 48 skipped
   ```

   A credential-shaped value and a bare-domain value both became evidence without their dedicated checks. Restoring those checks made all six sensitive static-field cases pass.

## GREEN implementation

- A `StaticText` node is split only when it contains exactly one Chinese or ASCII colon, has non-empty normalized label/value parts, stays within 80/256 code-point caps, contains no control characters, and has a field-like label plus a date or bounded scalar value.
- The label must match the frozen current inspect intent through the pre-existing `relevantValue` rule. Unrelated fields keep their prior safe name-only representation and cannot become Orchestrator evidence.
- Structured projection fails closed for secret/credential labels, credential-shaped values, identity numbers, email/UUID data, filesystem paths, URLs, prompt-injection instructions, explanatory prose cues, delimiter spam, malformed pairs, and overlong fields.
- `safeText`/`sensitiveText`, semantic pagination, 500-node/128-KiB limits, opaque run-local refs/cursors, region restrictions, and existing textbox projection remain in the same path.
- The deterministic HTTPS fixture now uses a real display-only `<div>工作居住证有效期：2028-06-30</div>` instead of an input. The visible Renderer test expects the Main-owned field answer with source and parseable ISO read time.

## Orchestrator and persistence proof

- A real `BrowserPageInspector` snapshot containing one structured static date yields exactly one Main-owned final text block with label, value, page label/origin, and capture time.
- Provider prose claiming a different date is ignored for the durable answer.
- An unrelated safe field remains name-only in the transient inspected request, while prompt-injection text is dropped. Neither enters the persisted terminal blocks or simulated next-turn history. The next turn receives only the intentionally persisted Main-owned assistant answer.
- Two real structured matching values remain ambiguous; neither date nor provider-selected prose is persisted as the answer.
- No production Orchestrator logic was loosened, and browser final-action/injection guards are unchanged.

## Final verification

- Focused Inspector + Orchestrator: `2 files / 190 tests passed`.
- Full unit suite: `88 files / 2348 tests passed`; Electron 43.1.1 native compatibility preparation passed.
- Full typecheck: PASS for shared, workflow SDK, workflow schema, desktop Main, and Renderer.
- Full production build: PASS. Only the existing two VueUse `/* #__PURE__ */` placement warnings were emitted.
- Real Electron browser-continuation E2E: `19/19 passed` in 53.4 seconds. Renderer chat visibly returned the static date; `finalSubmissions` remained zero until the suite's explicit user click, and injection/final-action scenarios stayed blocked.
- Feature-diff ESLint over all five changed TypeScript files: exit 0, zero errors/warnings.
- `git diff --check`: PASS.

## Security assessment and remaining manual acceptance

The change adds no new tool, permission, origin, selector, persistent page-data channel, or action authority. It does not special-case the Beijing hostname or hardcode any production date. It only creates a structured value from already-readable display text when the frozen user intent and conservative field grammar both agree.

The user-assisted Beijing portal smoke has **not** been re-run by this automated fix and must be repeated on the real visible page. Acceptance should confirm that the actual displayed label/date is returned with source and read time, that unrelated page fields are absent from the durable conversation, and that no final action is performed.
