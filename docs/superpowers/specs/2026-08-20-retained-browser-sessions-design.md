# Retained Browser Sessions Design

## Goal

Fix repeated developer runs so unchanged schema refreshes preserve debug input, retain the visible controlled browser after every successful browser workflow, and make the bundled Chromium runtime a verified, user-facing dependency.

## Scope

- All workflow sources use the same browser retention behavior: developer runs, chat-triggered runs, and background runs.
- A successful execution retains its browser when one exists.
- Failed, cancelled, interrupted, timed-out, or explicitly closed browser executions clean up immediately.
- One retained browser is allowed per `workflowId`; the next browser execution for that workflow closes the retained browser before opening a new one.
- Different workflows may retain separate browsers.
- No workflow SDK, manifest schema, permission schema, or database schema changes are required.

## Developer Input State

`DebugPanel` currently deep-watches the `inputSchema` object. A build refresh parses an equivalent manifest into a new object, which reruns draft initialization and clears `debugInput` while uncontrolled primitive DOM inputs keep displaying their old values.

The panel will watch a stable key composed of the selected project ID and serialized input schema. Equivalent build refreshes preserve `debugInput`; project changes and actual schema changes reset it. Primitive inputs will read their displayed value from `debugInput`, ensuring UI and request state cannot diverge.

## Browser Lifecycle

`CapabilityPort` gains these lifecycle methods:

```ts
retainExecution(executionId: string, workflowId: string): Promise<void> | void
closeExecution(executionId: string): Promise<void> | void
```

After terminal persistence, `ExecutionService` calls `retainExecution` only for completed executions. If retention fails, it falls back to `closeExecution`. Other terminal statuses always call `closeExecution`. Policy grants are released after the browser transition so in-flight guarded navigation can settle safely.

`BrowserCapabilityService` keeps active automation states by execution ID and retained user sessions by workflow ID. Retention transitions are serialized to prevent concurrent completions from leaking contexts. Transitioning to retained mode waits for active operations, removes route/CDP navigation guards, disables later workflow operations, moves the state out of the active execution map, and attaches user-close cleanup. The browser uses its isolated temporary profile until the user closes it.

The next `browser.open` for the same workflow closes the previous retained context before launching. Application shutdown calls `BrowserCapabilityService.shutdown()` after execution shutdown and before database close, closing both active and retained contexts and removing profiles.

Retained sessions are not treated as active workflow execution contexts for maintenance admission. They have no worker connection or workflow permission state.

## Security and Failure Handling

After handoff, the browser is explicitly user-controlled: route interception and CDP navigation guards are removed, while the workflow worker is terminated and policy execution state is released. A half-completed handoff is never retained; failure closes the context and removes its temporary profile.

The shared error contract gains `BROWSER_RUNTIME_UNAVAILABLE`. Missing, malformed, escaped, damaged, or unlaunchable bundled Chromium resources map to this code. The renderer displays: `浏览器运行组件不可用，请重新安装 AutoForge。` Raw paths and launch errors remain hidden.

## Bundled Runtime

`pnpm dist:dir` remains the release entry point. `stage:browser` copies the exact Playwright Chromium archive for the current platform and architecture into application resources, and `electron-builder` includes it. End users do not install Chrome for Testing and the app does not download a browser at first use.

The packaged dependency verifier will validate `browser-runtime.json`, enforce that the resolved executable stays under packaged resources, require an actual file, and run the executable with `--version`. Packaging must fail if any check fails.

## Verification

- A schema-driven debug form runs twice without retyping and sends the same keyword both times.
- Completed executions retain browser contexts; failure and cancellation close them.
- Retained sessions allow subsequent user navigation, clean their profile on user close, and are replaced by the next execution of the same workflow.
- Different workflow IDs retain independent contexts.
- Application shutdown closes retained contexts.
- Missing runtime files and launch failures produce `BROWSER_RUNTIME_UNAVAILABLE`.
- Packaged verification executes bundled Chromium.
- Focused tests, full tests, typecheck, lint, build, and packaged verification pass.

