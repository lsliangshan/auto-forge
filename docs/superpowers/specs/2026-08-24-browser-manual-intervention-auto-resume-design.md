# Browser Manual Intervention Auto-Resume Design

## Status

Approved in chat and reviewed on 2026-08-24. This design extends
`2026-08-24-browser-login-auto-resume-design.md` and
supersedes its requirement that non-login browser handoffs are terminal. The
existing browser-continuation security, privacy, provenance, and protected
action rules remain unchanged.

## Goal

When browser automation cannot continue and Main cannot prove a precise cause,
AutoForge must not invent a login or other explanation. It gives the user
physical control of the exact bound page, displays a generic intervention
message, waits without consuming model calls, and resumes the same chat turn
automatically after the user has operated the page and then stopped interacting
for five seconds.

The interaction must remain interruption-safe: AI cannot reclaim the page while
the user is still operating it, and every resumed model decision must use a
fresh page inspection.

## Required Product Behavior

1. Only positive authentication evidence may produce the login-specific
   “等待你登录” state. An uncertain authentication state uses the generic manual
   intervention state.
2. Protected actions, unsupported controls, ambiguous targets, and other safe
   browser-interaction blockers with a live authorized page suspend the current
   run for manual intervention instead of completing it.
3. Lifecycle, security, and infrastructure failures remain terminal. This
   includes user cancellation, page closure, domain-policy rejection, workflow
   invalidation, lost ownership, input-shield failure, and action-limit failure.
4. Generic intervention displays:

   > 自动操作暂时无法继续，请在网页中手动操作。停止操作 5 秒后将自动继续。

5. During manual intervention, the exact tab stays reserved for the original
   run, the input shield is detached, and physical mouse and keyboard input
   reaches the page normally.
6. Auto-resume is armed only after at least one physical keyboard or actionable
   mouse event occurs after suspension. Page activity alone cannot arm it, so a
   background refresh cannot create a five-second resume loop.
7. Every qualifying activity resets the five-second quiet window. Page
   promotion succeeds only if both page identity and manual-activity revision
   remain unchanged through shield restoration.
8. A successful promotion discards all pre-intervention snapshots, element
   references, semantic fingerprints, and private evidence. Main forces a fresh
   inspection before it asks the model to continue.
9. If fresh inspection or the next guarded operation encounters another manual
   blocker, the run suspends again and requires new post-suspension activity.
10. Stop, page close, conversation deletion, account change, workflow
    invalidation, application reset, and shutdown terminate the wait and clean
    up every listener and timer.
11. Manual wait time is excluded from the active five-minute browser automation
    budget.

## Classification Contract

The host must distinguish evidence-backed causes from presentation fallback.

- `AUTH_REQUIRED`: positive logged-out evidence; use authentication probing and
  the login-specific status.
- `MANUAL_ACTION_REQUIRED`: a protected operation that policy requires the user
  to perform; enter resumable manual intervention.
- `UNSUPPORTED_CONTROL`: the host cannot safely operate the control; enter
  resumable manual intervention.
- `TARGET_AMBIGUOUS` or `AUTH_STATE_UNKNOWN`, when a live in-policy bound page is
  still owned: do not guess a cause; normalize to a new generic
  `MANUAL_INTERVENTION_REQUIRED` handoff.
- `PAGE_CHANGED`: retry through the existing fresh-inspection boundary while
  retry limits permit; do not mislabel it as authentication.
- lifecycle, policy, ownership, integrity, action-limit, or infrastructure
  errors: terminate with their existing safe failure behavior.

`MANUAL_INTERVENTION_REQUIRED` is a stable host-owned code, not model-authored
copy. Renderer text is selected from the code, so a model cannot claim that the
user is logged out or that a particular control caused the interruption.

## Architecture

### Suspended ownership modes

The executor retains one lease and records a discriminated suspension mode:

- `authentication`: resumed only by the existing bounded authentication probe;
- `manual_intervention`: resumed only after post-suspension activity followed
  by the five-second quiet window.

Both modes detach the shield, keep the tab reserved, pause the active-operation
budget, and invalidate browser evidence. Non-authentication handoff no longer
releases the lease or terminalizes the run.

### Activity observation

`ElectronBrowserWorkspace` owns a monotonic manual-activity revision for each
suspended continuation. It emits a bounded activity notification for:

- physical key-down input;
- physical mouse-down, mouse-up, or wheel input, excluding pointer movement;
- main-frame navigation, redirect, same-document navigation, and load-state
  changes that can follow a user action.

Synthetic AI input does not increment the manual revision. Events are metadata
only: they contain tab identity and revision, never keys, entered values, mouse
coordinates, page text, credentials, OTPs, or CAPTCHA content.

The continuation-state token used for manual promotion contains the current
origin, URL, navigation epoch, and manual-activity revision. Existing URL and
workflow eligibility checks still apply.

### Manual resume coordinator

A Main-process `BrowserManualResumeCoordinator` owns one lightweight waiter per
run. It subscribes to workspace activity notifications and maintains a single
five-second quiet timer. It does not use long polling and does not run in a
Worker: the work is event and timer bookkeeping around Main-owned
`WebContents`, so a Worker would introduce message-ordering races without
offloading meaningful computation.

The waiter ignores pre-suspension activity and remains unarmed until it observes
physical user input. Once armed, every later physical-input or page-activity
revision invalidates an in-flight promotion and restarts the timer. Timer,
listener, and abort cleanup is idempotent.

### Atomic promotion

After five quiet seconds, the coordinator captures a continuation-state token.
The workspace checks page identity and activity revision before and after
ensuring the input shield. Any intervening user input, navigation, page close,
or policy change rejects the promotion without marking automation active. The
executor remains suspended and starts another quiet window from the new state.

After successful promotion, no awaited work occurs between the final token
check and making the shield effective. This prevents physical user input from
being accepted concurrently with resumed automation.

### Agent orchestration

`AgentOrchestrator` keeps the request active for both suspension modes. Generic
handoff emits an `awaiting_user` browser status with
`MANUAL_INTERVENTION_REQUIRED`, then waits without calling the model. Successful
manual promotion changes the status to `inspecting`, supersedes old browser
tool messages and evidence, and host-forces `browser_session_inspect`.

The model never decides that the user has finished. It sees the page only after
the host's activity, quiet-window, identity, and ownership checks have passed.

## Data Flow

1. A browser inspect or guarded action identifies a manual blocker, or Main
   safely normalizes an uncertain live-page blocker.
2. The executor focuses and suspends the exact continuation tab, records the
   current activity revision, and invalidates transient evidence.
3. Chat displays the generic manual-intervention message. The task remains
   active and cancellable.
4. The user operates the unshielded page.
5. The first physical-input event arms auto-resume. It and subsequent workspace
   activity events advance the revision and restart the quiet timer.
6. Five seconds after the most recent activity, the coordinator captures the
   current page-and-activity token.
7. Workspace atomically restores the shield only if that token remains current.
8. Main forces a fresh inspection and continues the original chat turn.
9. The run either completes from fresh evidence, performs another safe action,
   or re-enters a suspension mode.

## User Experience

Login waiting remains visually distinct:

> 网页尚未登录，请在已打开页面完成登录。登录后将自动继续，无需再次提问。

All uncertain non-login blockers use the generic message:

> 自动操作暂时无法继续，请在网页中手动操作。停止操作 5 秒后将自动继续。

The status label is “等待你手动操作”. Stop remains enabled. Takeover is hidden
or disabled because the page is already under user control. Activity and quiet
timers do not add chat messages or repeatedly flash the status card. When the
quiet window expires, the card moves to “AI 正在读取网页” before the shield is
used for automation again.

## Safety and Lifecycle Contract

- No physical input after suspension: wait indefinitely, even if the page
  refreshes itself; never oscillate between AI and user control.
- New activity during the quiet window: restart the five-second timer.
- Activity during promotion: reject stale promotion and wait again.
- Redirect through several pages: every navigation resets the quiet window;
  only the final stable page can be promoted.
- Repeated blocker after resume: suspend again and require a new activity
  revision; do not spin automatically.
- Page leaves declared workflow and captured authentication URL policy: fail
  with `DOMAIN_BLOCKED`, even if the user caused the navigation.
- Page closes: fail with `PAGE_CLOSED`.
- Stop or lifecycle invalidation: cancel and release the lease immediately.
- Protected final actions remain user-only. Resuming after the user performs
  one does not authorize AI to repeat, undo, or infer consent for that action.

## Alternatives Rejected

### Fixed-delay resume without activity tracking

This would reclaim the page while the user is reading, typing, or considering a
protected action. It violates the non-interference goal.

### Model-based continuous readiness checks

Repeated screenshots or semantic inspections would consume model calls, expose
more page content, and still could not prove that the user had finished. The
host-owned activity gate is cheaper and deterministic.

### “完成并继续” button only

This is reliable but contradicts the requested automatic recovery. An explicit
button can be added later as an accessibility fallback, but it is not required
for this implementation.

### Dedicated Worker or long polling

Neither helps because input and navigation events originate from Main-owned
Electron objects. Event listeners plus one quiet timer per waiting run minimize
CPU use and avoid cross-thread promotion races.

## Verification

### Workspace and coordinator tests

- suspended physical input reaches the page and advances only metadata revision;
- pointer movement and synthetic AI input do not count as manual activity;
- first physical input arms the timer and later input or page activity resets it;
- no activity means no resume, including after arbitrary fake-clock advances;
- activity during shield restoration rejects promotion and leaves the page
  unshielded;
- navigation and same-document activity use the newest page token;
- cancel, close, reset, and shutdown clear listeners and timers exactly once.

### Executor and orchestrator tests

- each resumable handoff preserves the lease and pauses the active budget;
- uncertain live-page blockers use `MANUAL_INTERVENTION_REQUIRED`, never
  `AUTH_REQUIRED`;
- lifecycle and security failures remain terminal;
- five quiet seconds resume the same request without another user message;
- pre-intervention snapshots and private evidence are absent from resumed model
  messages;
- fresh inspection is host-forced before the model may continue;
- a repeated blocker waits for new activity rather than entering a resume loop;
- stop, takeover, page close, workflow change, account switch, and application
  shutdown terminate safely.

### Renderer and headless integration tests

- login and generic manual-intervention copy remain distinct;
- generic waiting is non-terminal and Stop remains enabled;
- the card returns to inspecting after quiet-window promotion;
- deterministic headless tests cover typing without navigation, navigation,
  same-document SPA changes, activity during promotion, and repeated blocking;
- no visible headed browser test runs without separate user approval.
