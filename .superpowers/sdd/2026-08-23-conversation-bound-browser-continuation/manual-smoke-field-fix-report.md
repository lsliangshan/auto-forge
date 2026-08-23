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

## Fix Round 1: narrow typed static evidence

### Independent RED evidence

1. Typed-value and durable-answer RED:

   ```text
   Test Files  2 failed (2)
   Tests       8 failed | 190 passed (198)
   ```

   The former bounded-scalar fallback projected business prose, instruction-like prose, an arbitrary `.io` domain, an AWS `AKIA...` access-key shape, a formatted phone number, and a contact name as values. The real Inspector-to-Orchestrator integration therefore became ambiguous instead of producing the one safe expiry answer. An ISO date-time also failed to structure because the old delimiter count treated its time colons as field-delimiter spam.

2. Raw-role RED:

   ```text
   BrowserPageInspector > does not project an InlineTextBox date as static field evidence
   1 failed | 62 passed
   ```

   Normalizing `InlineTextBox` to `statictext` before the projection gate allowed a layout fragment to become evidence.

3. Unicode pre-normalization RED:

   ```text
   BrowserPageInspector > drops a static field containing a Unicode $case before normalization
   2 failed | 67 passed
   ```

   Trailing U+2028 and U+2029 were collapsed/trimmed as whitespace, leaving a valid-looking date value. Mixed U+2028/U+2029 instructions, zero-width U+200B, and bidi U+202E cases were added to the same boundary suite.

### GREEN contract and security analysis

- Static display evidence now has a narrow typed whitelist only: a calendar-valid `YYYY-MM-DD`, a calendar/time/UTC-offset-valid ISO date-time, or a pair of valid ISO dates separated by `至`, `到`, `~`, `～`, or `–`. There is no arbitrary short-scalar or prose fallback.
- A field is considered for structuring only when the raw AX role is exactly `StaticText`. `InlineTextBox` remains a safe semantic name-only node and can never supply evidence.
- Raw `StaticText` containing Unicode categories `Cc`, `Cf`, `Zl`, or `Zp` is discarded before `safeText` or whitespace normalization. This rejects C0/C1 controls, line/paragraph separators, zero-width format characters, and bidi controls rather than allowing them to join or conceal content.
- Existing label/value length caps, `safeText`/`sensitiveText`, sensitive labels, prompt-instruction rejection, and the frozen inspect-intent relevance check remain fail-closed. Invalid but relevant label/value pairs are discarded, so arbitrary prose, names/contact data, phone/private-number shapes, all URLs/domains, paths, identity data, and credential/key/token shapes cannot become evidence or enter the provider tool snapshot through this new path.
- ASCII time colons are accepted only when the entire value matches the typed date-time grammar. Repeated field delimiters and mixed trailing content remain invalid.
- The Agent integration again yields exactly one Main-owned `工作居住证有效期：2028-06-30` answer with source and read time, ignores provider prose, and excludes all rejected raw field text from terminal state and simulated next-turn context. The only persisted page-derived value is the intentionally persisted final assistant answer. The existing two-matching-values case remains ambiguous.
- Pagination, serialized-size enforcement, opaque run-local refs/cursors, durable-context exclusion, final-action protection, and injection authority remain unchanged.

### Fix Round 1 verification

- Focused Inspector + Orchestrator GREEN: `2 files / 205 tests passed`.
- Changed-file ESLint: exit 0, zero errors/warnings.
- Full native-aware unit suite: `88 files / 2363 tests passed`.
- Full typecheck: PASS.
- Full production build: PASS; only the two pre-existing VueUse annotation warnings were emitted.
- Real Electron browser-continuation E2E: `19/19 passed` in 53.5 seconds. The Renderer static-expiry case passed and the final-action/injection cases remained blocked.
- `git diff --check`: PASS.

The user-assisted Beijing portal smoke still has **not** been re-run and remains required after Fix Round 1.

## Fix Round 2: closed static-date labels

### RED evidence

The expanded Inspector-to-Orchestrator suite failed at both boundaries before the production change:

```text
Test Files  2 failed (2)
Tests       13 failed | 198 passed (211)
```

- The broad field-label grammar accepted the exact requested malicious suffix cases: a name, formatted phone number, repeated date, and AWS access-key shape appended to `工作居住证有效期`. The relevance bigram still matched, so each valid date became evidence.
- A domain label failed structuring but crossed the semantic boundary through the name-only fallback.
- Unrelated date fields, colon-bearing prose, and malformed colon pairs likewise survived as raw name-only page text.
- The real Inspector snapshot consequently contained multiple matching values, and the Orchestrator returned the ambiguity response instead of the one Main-owned expiry answer.

### GREEN contract and security analysis

- Static date labels are now an exact, case-normalized closed set. It includes the two observed real labels (`有效期至` and `工作居住证有效期`), the bounded Chinese date variants specified in review, and narrowly enumerated English expiry/issue/effective/application/deadline equivalents.
- Arbitrary CJK or alphanumeric prefixes/suffixes cannot match. Names, phones, digits, domains, credential shapes, and repeated dates in the label are rejected even when they contain the same relevance bigrams as an allowed label.
- For raw `StaticText`, absence of a colon still returns the ordinary safe untrusted semantic name. Once an ASCII or Chinese colon is present, every failed label, value, length, sensitivity, instruction, relevance, or delimiter check drops the entire node instead of falling back to the raw combined name.
- Calendar-valid ISO date, date-time, and date-range value types from Fix Round 1 remain unchanged. ASCII colons internal to a valid typed date-time remain accepted; delimiter spam or mixed trailing content remains invalid and is dropped.
- The provider tool snapshot contains the one allowed observed field only. All invalid label/value pairs are absent, not merely value-less. The terminal answer and next-turn durable context contain only the intentionally persisted Main-owned answer with source and read time; provider prose and rejected raw page content remain excluded.
- The existing two-valid-values ambiguity behavior, exact raw `StaticText` role gate, Unicode pre-normalization rejection, pagination, serialized-size enforcement, run-local refs, injection defenses, and protected final-action boundary are unchanged.

### Fix Round 2 verification

- Focused Inspector + Orchestrator: `2 files / 228 tests passed`.
- Changed-file ESLint: exit 0, zero errors/warnings.
- Full native-aware unit suite: `88 files / 2386 tests passed`.
- Full typecheck: PASS.
- Full production build: PASS; only the two pre-existing VueUse annotation warnings were emitted.
- Real Electron browser-continuation E2E: `19/19 passed` in 53.6 seconds. Renderer returned the static expiry without submission; injection and protected final-action cases remained blocked.
- `git diff --check`: PASS.

The user-assisted Beijing portal smoke still has **not** been re-run and remains required after Fix Round 2.

## Fix Round 3: colon-confusable fail-closed detection

### RED evidence

The focused Inspector RED reproduced the name-only fallback bypass:

```text
Test Files  1 failed (1)
Tests       8 failed | 94 passed (102)
```

- U+FE55 SMALL COLON (`﹕`) and U+FE13 PRESENTATION FORM FOR VERTICAL COLON (`︓`) were not recognized by the canonical parser, so the entire raw string survived as name-only `StaticText`.
- The same bypass was reproduced for the visual colon confusables U+2236 (`∶`), U+A789 (`꞉`), U+02D0 (`ː`), and U+02F8 (`˸`), plus repeated compatibility delimiters.
- A complete code-point NFKC scan found U+2A74 DOUBLE COLON EQUAL (`⩴`, normalized as `::=`) in addition to U+FE13/U+FE55 and the canonical ASCII/fullwidth colons; its regression also failed before the fix.
- Canonical/confusable mixtures already failed value/label validation, and regression cases preserve that behavior explicitly.

### GREEN contract and security analysis

- Raw unsafe-character rejection still runs first. A separate noncanonical-colon detector then rejects any character whose individual NFKC form contains ASCII `:`, excluding the two intentionally canonical raw delimiters `:` and `：`.
- The detector additionally rejects the four common visual colon confusables above even though Unicode NFKC does not map them to ASCII colon.
- NFKC is used only as a rejection signal. The input is never normalized into the parser, and the accepted structured delimiter grammar remains exactly `[:：]`.
- Any confusable-only, repeated, or mixed delimiter node is dropped entirely before name-only fallback. Positive canonical ASCII/fullwidth labels, typed date values, frozen-intent relevance, source/read-time answer ownership, and durable-context exclusion are unchanged.
- No AgentOrchestrator production code, permission, action, persistence, pagination, or ref behavior changed.

### Fix Round 3 verification

- Exact impacted Inspector + Orchestrator matrix: `2 files / 238 tests passed`.
- Changed-file ESLint: exit 0, zero errors/warnings.
- Full typecheck: PASS.
- Real Electron browser-continuation E2E, including its production build: `19/19 passed` in 53.5 seconds. Static expiry still returned without submission; injection and protected final-action cases remained blocked.
- `git diff --check`: PASS.

The user-assisted Beijing portal smoke still has **not** been re-run and remains required after Fix Round 3.

## Fix Round 4: semantic date-hint fail-closed boundary

### Files changed

- `apps/desktop/electron/main/browser/browser-page-inspector.ts`
- `apps/desktop/electron/main/browser/browser-page-inspector.test.ts`
- `.superpowers/sdd/2026-08-23-conversation-bound-browser-continuation/manual-smoke-field-fix-report.md`

### RED evidence

The Round 4 Inspector regressions were added before the production change and run with:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-page-inspector.test.ts

Test Files  1 failed (1)
Tests       24 failed | 105 passed (129)
```

- The two lower/canonical-hyphen static-text role spellings kept canonical fields as combined name-only nodes instead of typed evidence.
- U+FE30 and the reviewer-listed U+0589, U+0703, U+0704, U+16EC, U+1803, U+1809, U+205A, U+05C3, U+A4FD, U+11DD9, and U+29F4 separator cases crossed the name-only fallback.
- Recognized labels with arbitrary values, ISO-date tokens with arbitrary or absent delimiters, and repeated arbitrary separators likewise survived as name-only page text.
- All three accepted raw static-text spellings reproduced the malformed-date fallback, while both canonical and ordinary `InlineTextBox` fragments were exported name-only.

### GREEN contract and security analysis

- The production confusable-character enumeration and NFKC rejection scan were removed. Structured parsing still consumes raw input and still accepts exactly ASCII `:` and fullwidth Chinese `：`; no other separator is normalized into acceptance.
- Canonical parsing is attempted for exactly the raw `StaticText`, `statictext`, and `static-text` spellings. If parsing fails and the raw text contains a member of the existing closed date-label set or an ISO-shaped date token, the entire node is dropped, independent of the intervening separator.
- `InlineTextBox` is no longer normalized into semantic static text, so neither its structured-looking nor ordinary layout fragments can become structured or name-only evidence.
- Ordinary non-date static text remains a name-only semantic node for all three accepted raw spellings, with no value added.
- Existing closed labels, date/date-time/range parsing, calendar validation, sensitive-text/instruction rejection, frozen-intent relevance, semantic budgets, refs/cursors, durable-context exclusion, and protected-action boundaries remain unchanged.

### Fix Round 4 verification

- Focused Inspector GREEN: `1 file / 129 tests passed`.
- Exact impacted Inspector + Orchestrator matrix: `2 files / 265 tests passed`.
- Full native-aware unit suite: `88 files / 2423 tests passed`; Electron 43.1.1 native compatibility preparation passed.
- Full workspace typecheck: PASS for shared, workflow SDK, workflow schema, desktop Main, and Renderer.
- Standalone production build: PASS; only the two pre-existing VueUse annotation-placement warnings were emitted.
- Real Electron browser-continuation E2E: `19/19 passed` in 53.7 seconds, including the visible static-field answer, zero implicit submission, injection rejection, and protected final-action handoff.
- Changed-file ESLint: exit 0, zero errors/warnings.
- `git diff --check`: PASS.

### Self-review and commit

- Mutation check: restoring name-only fallback for hinted malformed static text fails the new separator/date-hint matrices; restoring exact-`StaticText` parsing fails the role-variant positives; restoring `InlineTextBox` normalization fails both whole-node absence cases.
- The diff adds no origin, permission, action, persistence, pagination, private-data channel, or AgentOrchestrator production change.
- Round 4 is committed together as `fix(browser): fail closed on static date hints`.

The user-assisted Beijing portal smoke still has **not** been re-run and remains required after Fix Round 4.

## Fix Round 5: strict Chinese calendar date value

### Files changed

- `apps/desktop/electron/main/browser/browser-page-inspector.ts`
- `apps/desktop/electron/main/browser/browser-page-inspector.test.ts`
- `apps/desktop/electron/main/agent/agent-orchestrator.test.ts`
- `.superpowers/sdd/2026-08-23-conversation-bound-browser-continuation/manual-smoke-field-fix-report.md`

### RED evidence

The Chinese calendar value and real Inspector-to-Orchestrator behavior tests were added before the production change and run with:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts \
  electron/main/browser/browser-page-inspector.test.ts \
  electron/main/agent/agent-orchestrator.test.ts

Test Files  2 failed (2)
Tests       7 failed | 284 passed (291)
```

- All six combinations of the two observed labels (`有效期至` and `工作居住证有效期`) and three accepted raw static-text roles produced no structured value.
- The real Inspector snapshot therefore contained no requested field evidence, and AgentOrchestrator emitted the safe uncertainty response instead of the synthetic Main-owned answer.
- Calendar-invalid dates, strict-shape near misses, Chinese date-time/range variants, and the new `InlineTextBox` regression already stayed absent during RED; the failures were confined to the missing positive value type.

### GREEN contract and security analysis

- `safeStaticDateValue` now accepts one additional value grammar only: exactly four ASCII digits, literal `年`, two ASCII digits, literal `月`, two ASCII digits, and final literal `日`.
- The captured year/month/day are converted to the already-supported ISO shape and passed through the existing calendar validator, preserving its year floor, month/day bounds, and Gregorian leap-year behavior.
- Variable-width years/months/days, year zero, fullwidth and Arabic-Indic digits, Chinese numerals, missing `日`, hyphen/slash/dot substitutions with Chinese markers, internal whitespace, appended prose, Chinese date-time, and Chinese date ranges remain rejected.
- Existing ISO date, ISO date-time, and ISO date-range positives remain unchanged. Both observed labels project exactly one structured value for `StaticText`, `statictext`, and `static-text`; `InlineTextBox` remains wholly absent.
- The Inspector-to-Orchestrator integration returns the unique synthetic field as a Main-owned answer with page source and read time. Provider prose and rejected page content remain excluded from the terminal answer and the simulated next-turn durable context.
- No label, field-delimiter, raw-role, sensitivity, instruction, relevance, origin, permission, action, pagination, persistence, or fail-closed production path was relaxed. No real portal value was added to code, tests, logs, or this report.

### Fix Round 5 verification

- Focused Inspector + Orchestrator: `2 files / 294 tests passed`.
- Broader desktop browser suite: `5 files / 288 tests passed`.
- Full native-aware unit suite: `88 files / 2452 tests passed`; Electron 43.1.1 native compatibility preparation passed.
- Full workspace typecheck: PASS for shared, workflow SDK, workflow schema, desktop Main, and Renderer.
- Standalone production build: PASS; only the two pre-existing VueUse annotation-placement warnings were emitted.
- Real Electron browser-continuation E2E: `19/19 passed` in 53.6 seconds, including visible static-expiry extraction, zero implicit submission, injection rejection, and protected final-action handoff.
- Changed-file ESLint: exit 0, zero errors/warnings.
- `git diff --check`: PASS.

### Self-review and commit

- Mutation check: removing the new value branch fails the six role/label positives and the Main-owned durable-answer test; loosening ASCII width, separators, final `日`, or calendar validation is caught by the invalid and near-miss matrices; re-admitting `InlineTextBox` fails its whole-node absence case.
- The production diff is one anchored ASCII grammar plus reuse of the existing calendar validator. AgentOrchestrator production code and every authority/persistence boundary are unchanged.
- Round 5 is committed together as `fix(browser): accept strict Chinese calendar dates`.

The user-assisted Beijing portal smoke still has **not** been re-run after Fix Round 5 and remains required for real-site acceptance.
