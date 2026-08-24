# Browser Login Auto-Resume Design

## Status

Approved in chat on 2026-08-24. This design supersedes the login-handoff and
current-turn deferral behavior in
`2026-08-23-conversation-bound-browser-continuation-design.md`. Other security,
privacy, provenance, and protected-action requirements from that design remain
unchanged.

## Goal

When a user asks for personal data that requires a workflow-opened website,
AutoForge must continue the browser flow in the same chat turn. If the page is
logged out, AutoForge waits indefinitely for the user to sign in, then resumes
browser automation automatically and answers only from fresh authenticated
page evidence.

The wait ends only when authentication succeeds, the user stops the task, the
target page closes, the conversation or account is invalidated, or AutoForge
exits. Waiting does not survive an application restart.

## Required Product Behavior

1. A workflow that opens an eligible browser tab makes that binding available
   to the same Agent run immediately after the workflow completes.
2. A personal-data request that enters the browser path cannot fall back to
   policy knowledge or an unsupported model answer. Without unique browser
   evidence, it must wait or report a system-owned failure.
3. On explicit `AUTH_REQUIRED`, AutoForge focuses the exact tab, releases the
   input shield, and lets the user operate the page normally.
4. Chat shows that login is required and that automation will continue without
   another user message. Stop remains available; takeover is unnecessary while
   the page is already user-controlled.
5. Login waiting is indefinite and consumes neither model requests nor active
   browser-automation time.
6. Navigation, load, and page-invalidation events trigger a debounced login
   check. A low-frequency adaptive fallback detects same-document and SPA login
   changes that do not emit a useful navigation event.
7. `authenticated` resumes the original run. `required` and `unknown` continue
   waiting without repeatedly notifying the user.
8. Before resuming, Main revalidates user, conversation, workflow identity,
   binding eligibility, URL policy, and current origin. It then atomically
   restores automation ownership and the input shield.
9. Login-time snapshots and private-field evidence are discarded. Main forces
   a fresh inspection, and the final answer must cite a uniquely matched field
   label, value, page source, and capture time from the authenticated page.
10. Non-login handoffs such as protected final actions or unsupported controls
    remain terminal and require a later user request.

## Architecture

### Agent orchestration

`AgentOrchestrator` refreshes the browser continuation catalog after a workflow
finishes. If the current request requires browser evidence and a newly created
binding is eligible, the host routes the run into browser inspection instead
of accepting unsupported model text.

An `AUTH_REQUIRED` result transitions the active run into an in-memory
`awaiting_auth` state. The orchestrator persists and emits the system-owned
browser status, appends the bounded handoff tool result, and waits without
calling the model. Authentication success transitions through `resuming` and
causes a host-forced fresh inspection before normal model decisions continue.

The active chat request remains cancellable while it waits. The per-conversation
run admission rule continues to prevent a second request from replacing the
waiting run implicitly.

### Login wait coordinator

A Main-process `BrowserLoginWaitCoordinator` owns lightweight wait records
keyed by run and binding identity. It subscribes to workspace page events,
debounces event-triggered probes, and owns one adaptive fallback timer per
waiter. It does not run in a Worker because Electron `WebContents`, CDP, and
browser ownership are Main-owned; a Worker would add message-passing races
without removing work from Main.

The coordinator exposes cancellation-safe completion for authenticated,
page-closed, binding-invalidated, and aborted outcomes. Every terminal path
unsubscribes listeners and clears timers idempotently.

Authentication probes are host-owned and bounded. They classify only login
state and never retain or return passwords, OTPs, CAPTCHA values, form values,
raw page text, or page snapshots. Event probes run after a 500 ms stability
debounce. Fallback checks run every three seconds for the first minute and every
ten seconds afterward.

### Suspended browser ownership

The continuation registry and workspace distinguish active automation
ownership from suspended user-wait ownership.

During `awaiting_auth`:

- the exact tab remains reserved for the original run;
- the continuation input shield is detached;
- physical mouse and keyboard input reaches the page normally;
- other workflows and continuation runs cannot acquire the tab and receive
  `PAGE_BUSY`;
- snapshots and element references are invalidated.

On authentication, suspended ownership is atomically promoted back to active
automation ownership. The shield is installed before promotion completes. If
the page changes or eligibility fails during promotion, automation does not run
against stale state; the coordinator either continues waiting or terminates
with the safe failure required by the new state.

## Data Flow

1. Renderer sends the normal chat request.
2. Agent invokes the selected workflow.
3. Workflow opens the target tab and completes.
4. Agent refreshes current-run continuation bindings.
5. Main inspects the exact bound tab.
6. Explicit logged-out evidence produces `AUTH_REQUIRED`.
7. Main records `awaiting_user`, suspends automation ownership, focuses the tab,
   and begins the login wait.
8. The user signs in with unrestricted physical interaction.
9. Workspace events or the fallback timer trigger bounded authentication
   probes.
10. Confirmed authentication promotes ownership back to automation and refreshes
    the binding metadata.
11. Main performs a new inspection and continues safe browser actions as needed.
12. Unique authenticated evidence produces the final cited answer.
13. Terminal cleanup releases ownership, removes all wait resources, and
    invalidates transient browser data.

## User Experience

While waiting, the browser status card says:

> 网页尚未登录，请在已打开页面完成登录。登录后将自动继续，无需再次提问。

The status remains non-terminal. Stop is enabled. Takeover is hidden or disabled
because the user already controls the page. After authentication, the card
returns to an inspecting state. Repeated probes do not add chat messages or
status blocks.

## Error and Lifecycle Contract

- `required` or `unknown`: continue waiting.
- authenticated page changes before promotion completes: retry from current
  state; never use stale evidence.
- target page closes: fail with `PAGE_CLOSED` and explain that the page was
  closed.
- current URL leaves all captured allowed login and workflow patterns: fail
  with `DOMAIN_BLOCKED`.
- user stops: cancel the run and leave the page usable.
- conversation deletion, account switch, logout, application reset, or shutdown:
  cancel and clean up the waiter before dependent state is destroyed.
- workflow disablement, removal, version/source/build/fingerprint change: end
  with the existing safe workflow-change failure.
- protected or unsupported non-login handoff: preserve the existing terminal
  behavior.

All transitions and cleanup operations are idempotent. Login wait time is
excluded from the five-minute active browser-tool budget.

## Verification

### Unit and contract tests

- login wait state transitions and cleanup are deterministic under fake timers;
- event-triggered probes debounce and adaptive fallback detects an SPA login;
- probes never expose or persist private form values;
- suspended ownership permits physical input but rejects competing automation;
- promotion restores the input shield before automation resumes;
- cancel, close, invalidation, and shutdown remove listeners and timers exactly
  once;
- login wait time is excluded from active automation budget.

### Main integration tests

- a binding created by a workflow becomes available to the same Agent run;
- the run emits an awaiting-login status and does not terminalize or call the
  model while logged out;
- authentication automatically triggers a fresh inspection and returns the
  exact authenticated expiry field;
- pre-login snapshots and evidence cannot support the final answer;
- no browser evidence means no generic personal-data answer;
- a waiting tab cannot be acquired by another workflow or continuation;
- page close, stop, account switch, conversation deletion, and shutdown each
  terminate safely without leaked wait resources.

### Renderer and headless verification

- awaiting-login is rendered as non-terminal;
- Stop remains enabled and takeover is unavailable while the page is already
  user-controlled;
- status changes from awaiting login back to inspecting and then completed;
- the deterministic headless browser-continuation fixture covers both
  navigation-based and same-document login recovery.

Visible headed browser testing is outside automated verification unless the
user separately authorizes it.
