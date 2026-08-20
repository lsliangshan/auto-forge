# Electron Browser Workspace Design

## Goal

Replace the external Playwright Chromium window with one Electron `BaseWindow` that hosts multiple persistent target-page tabs. Browser workflows keep their pages after execution, reuse website state on later runs, and no longer require Chrome for Testing. Also fix the developer debug form so an unchanged value is submitted on consecutive runs.

## Approved Product Behavior

- A single Electron browser workspace window contains all target pages as tabs.
- Each target page is an untrusted, sandboxed `WebContentsView`; a separate trusted view renders the tab strip and navigation controls.
- Browser tabs remain open after workflow completion, failure, cancellation, or timeout. Only an explicit `ctx.browser.close()`, a user tab/window close, application shutdown, or renderer crash destroys a tab.
- A later run of the same workflow reuses an idle tab and navigates it to the requested URL. Concurrent runs receive independent tabs.
- All browser workflows belonging to the same AutoForge user share one persistent Electron session. Different AutoForge users use different partitions.
- Cookies, localStorage, IndexedDB, Cache Storage, HTTP cache, and service workers persist across application restarts. `sessionStorage` persists only while its tab remains alive.
- Existing workflow SDK and manifest contracts remain unchanged: `open`, `fill`, `click`, `url`, and `close`; locators remain `css=...` or `role=...[name="..."]`.

## Layer Boundaries

### Execution layer

`ExecutionStartInput` carries the authenticated AutoForge `userId` as main-process-only context. `ExecutionService` copies it into capability requests; it is never sent to workflow code. Developer runs obtain the active authenticated session, and agent-triggered runs reuse the agent run's existing user attribution.

Terminal execution cleanup calls `closeExecution(executionId)`. For browser capability this now releases automation ownership without closing the tab. Other capabilities keep their current cleanup semantics.

### Browser capability layer

`BrowserCapabilityService` keeps permission enforcement and the public workflow contract. It owns only execution-to-tab bindings and delegates rendering, persistent sessions, navigation, and DOM/CDP interaction to a browser workspace port.

Before and after every operation it verifies the active origin. Main-frame navigation and popup creation are restricted to the currently declared origin while workflow automation owns a tab. After execution release, the page remains sandboxed but becomes user-controlled and is no longer backed by workflow permission state.

### Electron workspace layer

`ElectronBrowserWorkspace` owns:

- one lazily-created `BaseWindow`;
- one trusted toolbar `WebContentsView`;
- zero or more sandboxed target `WebContentsView` tabs;
- persistent Electron sessions keyed by a SHA-256 digest of the AutoForge user ID;
- tab activation, close, back, forward, reload, resize, and title/address updates;
- CDP-backed selector resolution and browser input.

The partition format is `persist:autoforge-browser-<digest>`. Sharing the partition gives same-user tabs browser-like login reuse while Chromium's origin rules continue to isolate website storage. Raw user IDs never appear in partition names.

Only the active target view is attached below the toolbar. Inactive views remain alive but detached, preserving their DOM and `sessionStorage`. Closing the `BaseWindow` explicitly closes every target and toolbar `webContents`, as required by Electron's `BaseWindow` resource model.

## Automation Compatibility

The workspace attaches Electron's `webContents.debugger` to target tabs and uses the Chrome DevTools Protocol:

- `css=` resolves through the DOM domain and must match exactly one element.
- `role=` resolves through the Accessibility tree and must match exactly one element; an optional accessible name is exact.
- `fill` updates supported editable controls and dispatches input/change events in the target renderer.
- `click` scrolls the node into view and dispatches real mouse events at its content box.
- navigation-causing clicks wait for the resulting load to settle before returning.

Invalid locator syntax, zero matches, duplicate matches, and unsupported editable nodes map to `INVALID_INPUT`, preserving existing behavior.

## Security

Every remote target view disables Node integration, enables context isolation and sandboxing, keeps web security enabled, disables webviews and insecure content, disallows drag navigation, and has no preload or IPC bridge. Target sessions deny permission requests/checks by default. Only HTTPS top-level URLs are accepted. New windows are denied during restricted automation unless their exact origin is permitted. Downloads and external protocol launches are denied by default.

The toolbar is a separate sandboxed view containing application-owned markup. Commands use an internal navigation scheme intercepted entirely in the main process; no Electron or Node API is exposed to toolbar JavaScript.

## Proxy and Lifecycle

Each persistent browser session receives the current AutoForge proxy configuration before use. A settings transition refreshes all live browser sessions and closes their network connections so the new proxy takes effect.

Application shutdown first stops workflow execution, then closes the browser workspace, then closes storage. User-closing the browser window destroys live web contents but not the persistent partition data, so a later run restores website state in new tabs.

## Packaging

Remove `playwright-chromium`, `stage:browser`, `browser-runtime.json`, `ms-playwright`, and the corresponding electron-builder resources. Electron already ships the Chromium engine used by `WebContentsView`; no runtime download or user-installed browser is required.

## Developer Input State

`DebugPanel` watches a stable key composed of selected project ID and serialized input schema instead of deeply watching each newly parsed manifest object. Equivalent build refreshes preserve `debugInput`; a real project/schema change resets it. Primitive form controls become controlled inputs so visible values cannot diverge from submitted state.

## Verification

- A schema-driven debug form submits the same keyword twice without retyping.
- Same-user tabs receive the same persistent partition; different users do not.
- Completed, failed, cancelled, and timed-out workflows release automation but keep tabs.
- Explicit close and user close destroy tabs without clearing persistent session data.
- Multiple workflows appear as switchable tabs in one `BaseWindow`.
- CSS and role locators preserve exact single-match behavior.
- Navigation, popup, permission, and remote-content security guards deny out-of-scope behavior.
- Proxy changes reach every live persistent browser session.
- Focused tests, full tests, typecheck, build, and packaged directory verification pass.

