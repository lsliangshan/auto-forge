# AI Browser Field Semantic Matching Design

## Goal

When a user asks for a field from a conversation-bound workflow page, use the
active text model to decide whether the user's wording and a visible field label
refer to the same semantic attribute. Do not encode synonym or field-category
matching tables in application code.

Examples are requirements, not rules:

- `证件号码` may match `证件编号` because the model judges them semantically equivalent.
- `证件类型` must not match `证件号码` because they refer to different attributes.

## Trust boundary

The model decides only which candidate labels match. It never supplies, edits,
or repeats a page value as authority.

Main remains authoritative for:

- the trusted current-user request;
- the exact bound page, snapshot, origin, and navigation epoch;
- visible-field extraction and blocked secret/control categories;
- candidate IDs and their host-only values;
- uniqueness, freshness, cancellation, and answer rendering.

Password, OTP, CAPTCHA, cookies, tokens, hidden inputs, national identity-number
shapes, and other existing blocked data remain unavailable to the matcher.

## Two-phase evidence flow

1. `BrowserPageInspector` recognizes a bounded visible structured field and
   creates an opaque ref plus a sanitized label. Its value is retained only in
   run-local Main memory as private evidence and is omitted from the
   model-visible `BrowserPageSnapshot`.
2. `BrowserContinuationToolExecutor` returns the public snapshot and a separate
   host-only evidence channel. `AgentOrchestrator` validates that every private
   item belongs to the exact returned snapshot and strips the private channel
   before serializing the tool result to the chat model.
3. At final browser-answer time, Main deduplicates current private evidence and
   invokes an isolated semantic-matching request through the same frozen
   `ModelProviderSnapshot` and text model as the chat request.
4. The matching request contains only the trusted user request and bounded
   `{candidateId, label}` objects. It contains no field values, page prose,
   cookies, storage, URLs, or conversation history.
5. The model must call one strict `report_browser_field_matches` function with
   all semantically matching candidate IDs. There is no synonym dictionary or
   substring fallback.
6. Main accepts only known, unique IDs. Exactly one semantic match produces an
   answer using the corresponding host-only value. Zero or multiple matches use
   the existing unable-to-confirm response.

## Model call

The matcher uses the active run's frozen provider snapshot, selected text model,
user ID, request ID, cancellation signal, and existing `trackProviderStream`
usage accounting. OpenRouter cost and token usage therefore remain attributed to
the same chat run.

The matcher is fail closed. It returns no match when the provider fails, times
out, emits prose instead of the required tool call, calls more than one tool,
returns unknown or duplicate IDs, exceeds bounds, or finishes for any reason
other than `tool_calls`.

## Visible structured evidence

Field extraction remains deterministic because it is a security boundary, not a
semantic matcher. It validates visibility, delimiter structure, bounded label
and value lengths, control characters, instruction-like content, and blocked
secret/private shapes. It does not compare the label with the user's wording.

The model-visible snapshot may show the sanitized label, but never the private
value before a successful semantic decision. Existing interactive control values
needed for authorized browser actions are unchanged and are not part of this
static-field matching path.

## Lifecycle and persistence

Private evidence and semantic decisions are run-local only. They are cleared on
completion, cancellation, takeover, page invalidation, or navigation. Values and
matcher payloads are not written to chat tool messages, browser audit rows,
diagnostic logs, or durable workflow state.

## Verification

Automated coverage must prove:

- a model decision matches `证件号码` to `证件编号` and returns the page value;
- a model decision rejects `证件类型` versus `证件号码`;
- arbitrary model prose cannot become a value;
- unknown, duplicate, zero, and multiple candidate IDs fail closed;
- model-visible inspect results omit private values;
- matcher requests contain labels but not values or unrelated page text;
- usage, cancellation, provider snapshot, and origin/snapshot validation remain
  intact;
- existing exact, education, expiry, ambiguity, handoff, and injection tests do
  not regress.
