# Conversation-Bound Browser Continuation Design

## Status

Approved product behavior was established in chat on 2026-08-23. This document
specifies the technical design only. It does not authorize implementation.

## Goal

Allow a later text-chat turn to continue operating the exact live Electron
browser tab opened by an earlier workflow in the same conversation. The Agent
may inspect authenticated page content, navigate, fill fields, and modify draft
data, but it must hand the page to the user before any action that makes a
business transaction final or otherwise has a protected external effect.

The motivating flow is:

1. A chat turn invokes a Beijing work-residence-permit workflow.
2. The workflow opens the government site in the AutoForge browser workspace.
3. The user signs in manually and leaves the tab open.
4. A later turn asks for the user's actual permit expiry date.
5. The Agent reuses that exact tab, reads the relevant field, and answers with
   the field label, value, source page, and read time.
6. If the page clearly requires authentication, AutoForge focuses the tab and
   asks the user to sign in before a new chat turn continues.

## Approved Product Behavior

- Browser continuation is limited to the same authenticated AutoForge user and
  the same `conversationId` that launched the workflow.
- Only a live target tab can be continued. Closing the tab or browser window,
  deleting the conversation, changing the workflow security identity, or
  restarting AutoForge revokes the active binding.
- Every workflow with at least one declared `browser.*` permission is
  automatically eligible to create a continuation binding. Existing workflows
  do not need a manifest migration merely to become candidates.
- Compatibility eligibility does not grant arbitrary browser access. Read
  access is run-scoped, and actions remain constrained by the originating
  workflow's declared actions and HTTPS origin patterns.
- The user's current message is the authorization for the current continuation
  run. There is no redundant confirmation dialog for every read or reversible
  edit, but the operation is visible and can be stopped or taken over.
- The Agent may read, navigate, expand controls, search, paginate, fill fields,
  update draft values, save drafts, and enter intermediate steps.
- The Agent may not perform formal submission, confirmation of a change,
  signature, payment, publication, deletion, withdrawal, logout, or any action
  whose external effect cannot be determined confidently. Those actions require
  a visible user handoff.
- The Agent never reads or enters passwords, one-time codes, CAPTCHAs, or
  signatures. It does not upload or download files in this version.
- The Agent can operate common text, date, radio, checkbox, select, button, tab,
  pagination, and scrolling controls. Unsupported or ambiguous custom controls
  are handed to the user.
- Page snapshots, screenshots, and raw tool results exist only for the current
  Agent run. Durable state contains the final chat answer and redacted audit
  metadata, never raw personal page content or entered values.
- Website content is untrusted tool data. It cannot change the user request,
  grant capabilities, expand origins, override protected-action policy, or
  instruct the Agent to inspect another page.
- The final visible answer identifies the exact field and value used, the page
  title or origin, and the read time. The Agent does not infer a personal value
  from policy knowledge or an ambiguous page.

## Scope

This change applies to text chat routed through `AgentOrchestrator`,
Agent-triggered workflows, the Main-owned browser capability broker, the
Electron browser workspace, system-owned chat status, and redacted task audit.

It does not add:

- continuation across AutoForge restarts;
- cross-conversation or cross-user attachment;
- automatic attachment to developer/manual executions that have no chat
  conversation;
- raw CDP or arbitrary JavaScript tools for the model;
- background observation after a run finishes;
- automatic login, CAPTCHA handling, signature, payment, upload, or download;
- final submission of a form;
- a general browser-history or cookie viewer;
- automatic continuation of a tab created by the current chat turn. A new
  binding becomes available on the next user turn.

## Existing Behavior and Gaps

AutoForge currently owns one process-level Electron `BaseWindow` containing
multiple target `WebContentsView` tabs. Each target is sandboxed and uses a
persistent session partition derived from the AutoForge user ID. A completed
workflow releases `ownerExecutionId` but leaves its tab and website state live.

The workspace currently reuses an idle tab by `userId + workflowId`. A tab does
not retain `conversationId`, `chatRunId`, workflow version, source, build hash,
or security fingerprint. If multiple idle tabs match, selection is map order.
That identity is insufficient for conversation-scoped continuation and is
weaker than the versioned workflow permission model.

The browser workspace already uses `webContents.debugger` with CDP 1.3 for
exact CSS/role lookup, filling, and clicking. The public browser surface is only
`open`, `fill`, `click`, `url`, and `close`. It has no page inspection,
structured snapshot, login-state classification, protected-action guard,
continuation lease, or direct Agent browser tools.

`AgentOrchestrator` currently offers model tools only for eligible workflows.
The durable relation `conversation -> chat_run -> execution` exists in SQLite,
but the retained tab discards that provenance when execution ownership ends.

`BrowserCapabilityService.reset()` and `shutdown()` exist, but application
logout and application shutdown do not currently use them. These lifecycle
gaps must be closed before authenticated page continuation is enabled.

## Approaches Considered

### Main-owned continuation tools backed by the originating workflow policy

This is the selected approach. The Agent receives a small fixed set of
high-level tools only when the current conversation has eligible live bindings.
Main resolves each operation to an exact tab, checks user/conversation/runtime
identity, acquires an exclusive lease, validates origin and action policy, and
then delegates a narrow operation to the workspace.

This supports new follow-up questions without requiring every workflow to
pre-code them. It also keeps CDP, browser sessions, permissions, page data, and
audit in Main.

### Re-run the original workflow for every follow-up

This reuses the existing Worker capability path and manifest checks, but it can
answer only questions anticipated by workflow code and output schema. It cannot
provide general follow-up interaction with the retained authenticated page, so
it is not selected.

### Expose raw CDP or `Runtime.evaluate` to the model

This is not selected. It would bypass the narrow capability broker, make final
submission controls unenforceable, expose cookies and hidden data, and let
untrusted page content steer arbitrary JavaScript execution.

## Architecture

### Main-owned components

`AgentOrchestrator` remains the coordinating facade for admission, provider
streaming, cancellation, message persistence, and Renderer events. It gains a
narrow `BrowserContinuationCatalog` and `BrowserContinuationToolExecutor`
dependency rather than absorbing browser policy into the existing large class.

The feature is divided into focused units:

- `BrowserContinuationRegistry` owns live tab bindings and their lifecycle. Its
  in-memory state is the authority for whether a tab can be controlled now.
- `BrowserContinuationCatalog` returns an immutable snapshot of eligible
  bindings for one Agent run. It exposes safe workflow/page metadata, not raw
  `webContents`, locators, cookies, or page content.
- `BrowserContinuationToolExecutor` resolves model tool calls, obtains a lease,
  enforces budgets, and converts browser outcomes to structured Agent results.
- `BrowserPageInspector` produces bounded accessibility-based snapshots and
  opaque element references.
- `BrowserActionGuard` enforces runtime identity, origins, declared actions,
  page freshness, login/manual-action rules, and fail-closed compatibility
  defaults.
- `BrowserContinuationAuditRepository` persists only redacted binding and action
  metadata.
- `ElectronBrowserWorkspace` continues to own Electron/CDP objects. It exposes
  narrow continuation operations and never exposes `sendCommand` or
  `webContents` to Agent code.

### Binding creation

Only an Agent-triggered workflow execution with a valid `chatRunId` can create a
conversation binding. `ExecutionService` supplies Main-only provenance through
the browser capability context:

```ts
interface BrowserContinuationProvenance {
  userId: string
  conversationId: string
  chatRunId: string
  executionId: string
  workflowId: string
  workflowVersion: string
  source: 'installed' | 'development'
  buildHash?: string
  securityFingerprint: string
}
```

The first successful `browser.open` acquires or creates a tab with the full
runtime identity and frozen action-to-origin permission matrix. The workspace
must no longer reuse a tab by workflow ID alone. It may reuse only an idle tab
whose user, conversation, workflow version, source/build identity, security
fingerprint, and permission matrix all match. A legacy tab without that
provenance is not eligible for continuation or reuse by a versioned Agent run.

After the workflow reaches a terminal state, execution ownership is released
but the conversation binding remains active. If the bound page creates an
allowed popup or new tab, that child receives the same continuation provenance.
User-created unrelated tabs do not inherit it. Multiple relevant bound tabs are
listed as separate candidates; when metadata cannot identify one unambiguously,
the model must ask the user to choose.

### Binding identity and lifecycle

Every live binding has an opaque `bindingId` and exact `tabId`. Eligibility
requires all of the following to remain true:

1. current AutoForge user equals the binding user;
2. current conversation equals the binding conversation;
3. the tab and its `webContents` are alive;
4. no workflow execution or continuation run owns the tab;
5. current runtime identity and security fingerprint equal the captured values;
6. the workflow remains currently eligible: installed workflows remain enabled
   and integrity-valid, while development workflows additionally require
   developer mode and the same ready build;
7. the current origin matches the captured read patterns, and every action
   matches the origin patterns captured for that exact capability.

Active bindings are process-local and never rehydrated after restart. Durable
binding rows are audit records only. Startup marks any previously active audit
row as `stale`; it never locates a tab by URL or title and never silently
reattaches a new `webContents`.

Lifecycle behavior is:

- workflow terminal: release execution ownership, retain live binding;
- target close/crash: close the binding with `PAGE_CLOSED`;
- conversation deletion: cancel a current continuation, revoke its bindings,
  close tabs created exclusively for that conversation, then delete rows;
- workflow version/source/build/fingerprint change: revoke the old binding;
- AutoForge logout/account switch: cancel continuations, close all browser tabs,
  and revoke bindings before completing logout;
- AutoForge shutdown: stop executions, cancel continuations, close the browser
  workspace, then close storage;
- browser-data reset: close tabs and clear the selected user's persistent
  Electron session data;
- normal logout and shutdown do not clear persistent site cookies. A dedicated
  “清除浏览器数据” setting performs that destructive operation.

### Compatibility policy for existing workflows

A workflow is automatically continuation-eligible when its frozen permission
snapshot contains at least one `browser.*` capability. Main derives a
capability-to-origin-pattern matrix rather than a global origin/action
cross-product:

- inspection patterns: the union of all browser permission origins;
- action patterns: the original origin patterns for the exact `browser.open`,
  `browser.fill`, `browser.click`, `browser.url`, or `browser.close` capability;
- allowed actions: only actions implied by capabilities present in the matrix;
- `browser.fill`: text/date/select value edits;
- `browser.click`: buttons, tabs, pagination, radio, checkbox, and other
  reversible click actions;
- `browser.open` and `browser.url`: safe navigation and current-page metadata;
- `browser.close`: workflow close permission only; continuation does not give
  the model a close tool because user takeover is safer.

Page inspection is a host-owned continuation read, not a retroactive Worker SDK
grant. The user's current request creates a run-scoped `sensitive_read` decision
limited to the exact binding and currently matched origin. It expires when the
Agent run terminates and is never stored as a persistent permission grant.

The strict manifest gains an optional `browserContinuation` object so new or
updated workflows can refine safe defaults:

```ts
interface BrowserContinuationManifest {
  auth?: {
    loginUrls?: string[]
    loggedIn?: string[]
    loggedOut?: string[]
  }
  readableRegions?: string[]
  manualActions?: Array<{
    locator: string
    reason: string
  }>
}
```

URL values use the existing bounded HTTPS URL-pattern validator. Locator values
use the existing exact `css=...` or `role=...[name="..."]` grammar. Reasons are
bounded safe display text. The object is optional and participates in the
workflow security fingerprint. Missing configuration means:

- auth state begins as `unknown`;
- readable content is limited to bounded visible accessibility data;
- explicit login forms/URLs can produce `AUTH_REQUIRED`;
- protected or ambiguous actions fail closed and require handoff.

### Model-visible tools

Continuation candidates are snapshotted when an Agent run starts. Bindings
created later in that same run become eligible only on the next user turn. The
model receives safe binding metadata in tool descriptions: binding ID,
workflow name and version, page title, current allowed origin, and last-active
time.

The fixed tools are:

```ts
interface BrowserSessionInspectInput {
  bindingId: string
  intent: string
  mode?: 'semantic' | 'region_image'
  ref?: string
  cursor?: string
}

type BrowserValueSource =
  | { kind: 'current_user' }
  | { kind: 'history'; messageId: string }
  | { kind: 'page'; snapshotId: string; ref: string }

interface BrowserSessionActInput {
  bindingId: string
  snapshotId: string
  actions: Array<
    | { type: 'fill'; ref: string; value: string; source: BrowserValueSource }
    | { type: 'select'; ref: string; value: string; source: BrowserValueSource }
    | { type: 'click'; ref: string }
    | { type: 'check'; ref: string; checked: boolean }
    | { type: 'navigate'; url: string }
    | { type: 'scroll'; ref?: string; direction: 'up' | 'down' }
    | { type: 'wait'; milliseconds: number }
    | { type: 'focus' }
  >
}

interface BrowserSessionHandoffInput {
  bindingId: string
  reason: 'login' | 'manual_action' | 'unsupported_control'
  ref?: string
}
```

An `act` call contains at most ten actions. Main validates and executes them
sequentially, rechecking the tab and origin before and after every action. It
stops at the first failure and never executes the remaining suffix. Batching
keeps ordinary form filling within the existing ten-decision Agent loop without
weakening per-action checks. Browser actions have no cumulative per-run count
limit; user cancellation and the existing Agent lifecycle remain authoritative.

No tool accepts CSS, JavaScript, coordinates, a URL outside a bounded navigation
action, a raw CDP method, another conversation ID, cookies, storage keys, HTTP
headers, or filesystem paths.

Fill/select/check values may come only from the current user message, chat
content the user explicitly references for this task, or data inspected from the
same bound page for this task. The model must ask for a missing value. It may not
guess, search other conversations or tabs, read the clipboard, inspect local
files, or treat profile knowledge as permission to populate a field.
Main verifies `source` against run-local user/history/page evidence before
acting. Only deterministic normalization such as trimming, boolean/enum
selection, or converting an explicit date to the target control's ISO format is
allowed.

### Page inspection and ephemeral references

`BrowserPageInspector` uses the Accessibility and DOM domains to produce visible
semantic data. A snapshot contains:

- an opaque `snapshotId` bound to tab ID, navigation epoch, origin, and capture
  time;
- page URL, origin, title, and loading/auth classification;
- bounded visible text and semantic nodes;
- opaque element `ref`, role, accessible name, visible value when required for
  the user's task, enabled/selected/checked state, and supported actions;
- pagination metadata when the complete safe snapshot does not fit.

It excludes raw HTML, scripts, styles, comments, hidden inputs, cookies,
local/session storage, request/response bodies, headers, tokens, password and
OTP values, CAPTCHA images, unrelated frames, and arbitrary screenshot pixels.
Password/OTP/CAPTCHA controls are represented only as the presence of a manual
authentication requirement.

An exact visible certificate serial such as `证件编号` may be projected only
when the trusted current-user request explicitly asks for a certificate number.
The label and value use closed grammars, Chinese national identity-number shapes
remain blocked, and the projected value follows the same run-local provider-only
path as other page evidence. Audit rows and raw tool-result persistence remain
redacted.

`region_image` is available only when semantic inspection is insufficient, the
selected model accepts image input, and `ref` identifies one visible safe
region in the current snapshot. It captures no more than 1,000,000 pixels, never
captures a full page, and refuses password, OTP, CAPTCHA, signature, payment, or
file controls. The image exists only in the current provider request and is
subject to the same run-local, no-persistence rule as semantic snapshots.

The model-visible serialized snapshot is capped at 128 KiB and 500 semantic
nodes. The inspector prefers `readableRegions` when declared, then visible
landmarks relevant to the tool intent. Pagination uses an opaque run-local
cursor. Neither snapshots nor cursors are persisted.

Element references are valid only for their snapshot and navigation epoch.
`browser_session_act` rejects a stale snapshot, changed origin, detached node,
non-unique target, or changed target semantics with `PAGE_CHANGED`; it never
falls back to old screen coordinates.

### Action guard and final-action handoff

Before an action, `BrowserActionGuard` verifies in this order:

1. active run and cancellation signal;
2. user, conversation, binding, runtime identity, and exclusive lease;
3. current exact HTTPS origin against captured patterns;
4. required originating manifest action (`fill` or `click`);
5. fresh snapshot and unique visible supported element;
6. declared `manualActions` and host-owned protected-action policy;
7. login, CAPTCHA, file, signature, payment, and unsupported-control policy;
8. active-time and per-inspection read-size budgets.

Host-owned protected semantics include formal submission, confirmation of a
change, signature, payment, publication, deletion, withdrawal, and logout.
Button text is evidence but never the only guard. Form ownership, role, nearby
labels, current workflow stage, declared locators, and navigation expectations
also participate. If Main cannot establish that an action is reversible or a
draft-only mutation, it returns `MANUAL_ACTION_REQUIRED`.

For handoff, Main activates the exact tab, scrolls the target into view, applies
a temporary highlight through CDP `Overlay.highlightNode` without changing the
remote DOM, releases the automation lease, and ends the Agent run with a
system-owned instruction. The
user clicks the protected control manually. AutoForge does not watch the page
afterward. A later message such as “已提交，帮我查看结果” starts a new run and
re-inspects the page.

### Authentication classification

Authentication is evidence-based:

- a declared `loginUrls` match, declared logged-out marker, visible password/
  OTP/CAPTCHA form, or explicit site message can produce `AUTH_REQUIRED`;
- a declared logged-in marker can produce `authenticated`;
- absence of results, HTTP 200, or a page merely loading never proves either
  state;
- conflicting or insufficient evidence produces `AUTH_STATE_UNKNOWN`.

On `AUTH_REQUIRED`, Main focuses the page and ends the run. The user signs in
manually and sends a new chat message to continue. On `AUTH_STATE_UNKNOWN`, the
answer asks the user to inspect the visible page rather than claiming that the
account is logged out.

### Lease, cancellation, and user takeover

A tab has exactly one owner: workflow execution, continuation run, or user. A
continuation never steals a workflow-owned tab; it returns `PAGE_BUSY`. Two
conversations can continue different tabs concurrently, while the existing
one-run-per-conversation admission remains unchanged.

The trusted browser toolbar and chat status card both expose “停止” and “接管”.
Stop cancels the Agent run. Takeover cancels pending browser actions, releases
the lease, keeps the page visible, and lets the Agent finalize with a safe
user-takeover result.

While a continuation lease owns the active target tab, a dedicated trusted
`WebContentsView` named the input shield sits between the target view and the
52-pixel trusted toolbar. Its bounds cover only the target content area. Its
native Electron background and its full-viewport document use the minimum
nonzero alpha that participates in native hit testing while remaining visually
imperceptible. The view absorbs physical pointer and keyboard input; it does
not forward that input, mutate the target page, or convert it into implicit
takeover or cancellation. Explicit “停止” and “接管” controls remain available
above the shield.

The shield is created with the browser workspace and loaded once. Lease
acquisition synchronously sizes and inserts it above the target before
acquisition returns. Terminal completion, failure, cancellation, handoff, and
explicit takeover synchronously remove it before releasing control to the
user. The stacking order during automation is target, input shield, then
trusted toolbar. Outside automation the shield is detached, so the user can
interact with the target normally.

CDP automation continues to target the underlying target `webContents`
directly, so it is not routed through the shield. Target `before-mouse-event`
handling remains defense in depth only: a leaked non-synthetic event is
prevented without ending the run, and no security guarantee relies on timing or
event-source classification. This explicit-shield design supersedes implicit
keyboard/pointer takeover during an active continuation; takeover is an
explicit trusted control, so automation and manual input are never
intentionally interleaved.

## Data Flow

For a later continuation turn:

1. Renderer sends the normal chat request with `conversationId`.
2. Main admits the conversation and builds normal durable history.
3. `BrowserContinuationCatalog` snapshots live bindings for the exact user and
   conversation and adds the fixed continuation tools beside workflow tools.
4. The selected model either answers normally or calls `browser_session_inspect`.
5. Main resolves the binding, creates a run-scoped sensitive-read decision,
   acquires the tab lease, validates current origin, and returns a bounded
   untrusted snapshot.
6. The model may inspect another safe page segment, call a bounded action batch,
   request a handoff, or answer.
7. Main records only redacted action metadata and system-owned status updates.
8. The final answer is persisted normally. Raw tool protocol messages and page
   snapshots remain only in the active in-memory provider message list.
9. Terminal cleanup releases the continuation lease and invalidates snapshots.

## Persistence and Audit

Migration `0010_browser_continuation_audit.sql` adds two audit-oriented tables.
They do not restore active browser control after restart.

`browser_tab_bindings` records:

- opaque binding and tab IDs;
- user and conversation IDs;
- originating chat run and execution IDs when still available;
- workflow ID, version, source, build hash, and security fingerprint;
- frozen action-scoped browser permission matrix;
- `active`, `revoked`, `closed`, or `stale` status;
- safe terminal reason and timestamps.

`browser_action_audits` records:

- binding and optional chat-run ID;
- monotonic per-binding sequence;
- timestamp, exact origin, action type, bounded semantic target description,
  host-owned risk, outcome, and safe error/handoff code.

Audit rows never contain entered values, page text, snapshots, screenshots,
element IDs from the remote DOM, URLs with query/fragment, cookies, headers,
credentials, OTPs, CAPTCHA data, file paths, provider prompts, or model output.
Conversation deletion cascades its binding and action audit rows after live tabs
are closed.

System-owned `browser_status` chat blocks expose only binding ID, safe site
label/origin, `inspecting`, `acting`, `awaiting_user`, `completed`, `failed`, or
`cancelled` state, bounded action summary, and safe error code. Conversation
history serialization reduces them to concise provenance and never serializes
page content.

## Error Contract

Main uses explicit safe error states:

- `NO_BOUND_PAGE`: no eligible live page belongs to this conversation;
- `PAGE_CLOSED`: the selected tab or renderer no longer exists;
- `PAGE_BUSY`: a workflow or another continuation owns the tab;
- `AUTH_REQUIRED`: explicit evidence requires manual login;
- `AUTH_STATE_UNKNOWN`: login state cannot be established safely;
- `TARGET_AMBIGUOUS`: more than one page or element remains plausible;
- `DOMAIN_BLOCKED`: current or requested origin is outside captured patterns;
- `MANUAL_ACTION_REQUIRED`: the next action requires user handoff;
- `PAGE_CHANGED`: navigation epoch or target semantics changed;
- `UNSUPPORTED_CONTROL`: the control is outside the approved first-version set;
- `ACTION_LIMIT_EXCEEDED`: an operation budget was exhausted.

Raw CDP errors, stack traces, URLs containing personal query values, selectors,
and page excerpts never become generic chat error details. The model receives a
bounded structured result and may explain it, but cannot reinterpret a denial
as authorization.

## Operation Budgets

Each continuation run has these per-operation and lifecycle limits:

- ten actions in one `browser_session_act` batch;
- five minutes of active browser-tool time;
- 128 KiB and 500 semantic nodes per model-visible snapshot;
- the existing ten provider decision limit for the Agent loop.

There is no cumulative browser-action count limit and repeated equivalent
inspections do not terminate browser authority. Waiting for the user is not part
of a running continuation: login and protected actions terminate the run and
require a new message. Reaching a per-operation or lifecycle budget ends browser
automation, reports progress, and leaves the page visible.

## Renderer and Browser Workspace UX

During continuation, the chat status card and trusted browser toolbar show:

- workflow/page label and current origin;
- `正在读取网页`, `正在填写`, or another system-owned bounded action summary;
- a visible automation indicator;
- “停止” and “接管” controls.

The target page remains visibly unchanged beneath a transparent input shield,
but target-page pointer and keyboard interaction is disabled for the full
continuation lease. The shield is not a model-controlled page overlay and is
not injected into the remote site's DOM. It disappears synchronously when the
Agent run ends or the user explicitly stops or takes over, after which ordinary
target-page interaction resumes immediately.

The model cannot generate or modify this status. Final-action and login handoff
focuses the exact tab and explains what the user must do. Protected controls may
be highlighted, but AutoForge never overlays or simulates the user's final
click.

Task details show the redacted chronological audit. They do not offer snapshot
replay, reveal filled values, or store screenshots.

## Security and Privacy Invariants

- Renderer, workflow code, model output, remote page content, and page metadata
  are untrusted.
- Main alone owns live bindings, leases, origin policy, action policy, snapshot
  redaction, audit, and CDP access.
- The model receives no `webContents`, CDP session, cookies, storage, network
  traffic, filesystem access, clipboard access, or cross-tab enumeration.
- A binding never crosses AutoForge users, conversations, workflow security
  identities, or application processes.
- Current-page origin is reauthorized before and after every operation. A prior
  workflow permission grant or prior continuation run cannot authorize a new
  origin or new run. Origin patterns are checked per originating capability, so
  permission for `browser.open` on one site never implies `browser.click` there.
- Page instructions are data, never authority. Protected-action policy and tool
  schemas are host-owned and cannot be relaxed by prompts or workflow output.
- Sensitive page data is sent only to the already selected chat model and only
  in the current user-authorized run. It is not copied into summaries, raw
  history, logs, diagnostics, or audit tables.
- Normal logout closes visible personal pages and revokes automation before the
  authenticated app state changes. Site data remains isolated in the user's
  hashed persistent partition until explicitly cleared.

## Verification

### Contract and unit tests

- optional manifest continuation metadata validates strictly and participates
  in the workflow security fingerprint;
- every legacy workflow with a browser permission is eligible under conservative
  defaults, while non-browser workflows are not;
- derived origins and actions never exceed frozen manifest permissions;
- action-scoped origins do not collapse into a privilege-expanding cross-product;
- exact user, conversation, version, source/build, and fingerprint matching is
  required for reuse;
- snapshots exclude password/OTP values, hidden fields, storage, headers, and
  over-limit content;
- snapshot IDs and element references fail after navigation or semantic change;
- protected, ambiguous, unsupported, file, signature, payment, delete, and
  logout actions fail closed;
- login evidence distinguishes `AUTH_REQUIRED`, `authenticated`, and
  `AUTH_STATE_UNKNOWN`;
- audit schemas reject page text, entered values, query/fragment URLs, and
  oversized target summaries;
- browser actions remain unbounded across batches while time, node, and byte
  limits count exactly as specified.

### Main integration tests

- a workflow run creates a binding only when it belongs to an Agent chat run and
  successfully opens a tab;
- a later turn in the same conversation receives continuation tools and reads
  the retained page;
- another conversation and another user receive no access to that binding;
- current-turn bindings appear only on the next user turn;
- multiple candidate tabs cause deterministic selection or
  `TARGET_AMBIGUOUS`, never map-order reuse;
- workflow ownership causes `PAGE_BUSY`; terminal release permits continuation;
- version/source/build/fingerprint changes invalidate old bindings;
- disabling/uninstalling an installed workflow, closing developer mode, or
  invalidating a development build makes its binding unavailable;
- disallowed navigation blocks further access without closing the user page;
- page prompt injection cannot add tools, origins, actions, or final submission;
- raw snapshots and tool results are absent from messages, summaries, logs, and
  audit rows after completion;
- chat cancellation and takeover stop pending CDP work and release the lease;
- lease acquisition synchronously installs a dedicated target-sized input
  shield with stacking `target < shield < toolbar`, while CDP still reaches the
  target directly;
- physical input delivered to the shield does not mutate the target, revoke the
  binding, invalidate the page, cancel pending work, or release the lease;
- completion, failure, cancellation, handoff, and explicit takeover all remove
  the shield before target interaction resumes, including cleanup failures and
  replacement-run races;
- the shield's native and document paint remain visually imperceptible, while
  loading and blocked-origin trusted surfaces retain their existing appearance;
- conversation deletion closes bound tabs before database deletion;
- logout closes tabs and revokes bindings while preserving the user's partition;
- clear-browser-data removes that partition's site state;
- shutdown closes executions and browser continuations before database close.

### Renderer and real Electron verification

Use a deterministic HTTPS fixture with login, authenticated details, draft
autosave, dynamic navigation, a final submit control, popup, prompt-injection
text, and deliberate page mutation. Verify the real
Renderer -> Preload -> IPC -> Main -> Agent -> continuation executor -> CDP ->
visible Electron page -> Agent -> Renderer chain.

Visible acceptance covers:

- reading an explicitly requested authenticated expiry-date or certificate-number
  field and returning its exact evidence;
- manual-login handoff and continuation from a new user message;
- visible AI indicator, stop, takeover, and protected-action highlight;
- reversible form edits followed by a user-only final submission;
- cross-conversation denial, origin blocking, stale-page failure, concurrency,
  popup binding, unbounded cumulative actions, and lifecycle-budget termination;
- redacted task audit with no personal field values.

After deterministic verification, perform a user-assisted smoke test against
the target Beijing portal with the user controlling login and final submission.
Do not persist or attach screenshots containing personal information. A build,
provider HTTP success, workflow `completed` row, or mocked CDP call alone is not
acceptance.

## Acceptance Criteria

1. A later turn in the originating conversation can inspect and operate the
   exact live authenticated tab within the originating workflow policy.
2. The model answers the actual personal field value with source and read time,
   or returns a truthful structured handoff/error instead of policy knowledge.
3. A different user, conversation, workflow security identity, process, tab, or
   origin cannot reuse the binding.
4. Existing browser workflows automatically become candidates with conservative
   read/action defaults and no manifest migration requirement.
5. The Agent can edit drafts and intermediate steps but cannot perform or bypass
   any protected final action.
6. Login credentials, OTPs, CAPTCHAs, files, signatures, and payment controls are
   always user-operated.
7. Page data is bounded and ephemeral; durable chat history and audit contain no
   raw snapshot, filled value, credential, or personal page excerpt.
8. User stop/takeover, workflow ownership, page changes, origin changes, limits,
   close, delete, logout, and shutdown all release authority deterministically.
9. Website prompt injection cannot change tools, policy, origin, binding, or
   submission rules.
10. Focused tests, full tests, typecheck, build, deterministic real-Electron E2E,
    and visible user-assisted smoke verification all pass.

## Implementation Constraints

- Preserve Renderer -> Preload -> Main and Worker isolation boundaries.
- Keep raw Electron/CDP objects and page data in Main.
- Reuse the existing Agent tool protocol, conversation admission,
  `ExecutionService`, browser capability authorization, persistent user
  partitions, toolbar trust boundary, and workflow security fingerprint.
- Keep workflow continuation metadata optional; Q17 compatibility behavior is
  a host policy, not a migration requirement for existing workflows.
- Update strict manifest schema, TypeScript types, Registry/runtime identity,
  fingerprints, shared contracts, defaults, callers, and tests together.
- Build changed shared/workflow-schema packages before root typecheck so
  consumers do not use stale `dist` output.
- Do not add raw evaluate, network inspection, upload/download, background
  monitoring, cross-conversation attachment, or final submission as incidental
  implementation conveniences.
