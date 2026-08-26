# Task 8 execution boundary prerequisite report

## Root cause

Authenticated Agent chat runs are stored in the per-UID user cache, while workflow executions remain in the global database. `ExecutionService` passes the authenticated Agent run ID to the global execution repository, but global schema v12 still enforced `executions.chat_run_id REFERENCES chat_runs(id)`. Because the sealed legacy global `chat_runs` table does not contain the per-UID run, the execution insert failed before workflow startup.

## Fix

- Added global migration `0013_execution_user_cache_boundary.sql`.
- Rebuilt `executions` with `chat_run_id` retained as a nullable opaque correlation ID and removed only its legacy `chat_runs` foreign key.
- Rebuilt `execution_steps`, `execution_logs`, `browser_tab_bindings`, and `browser_action_audits` so their foreign keys point to the new tables while migrations run transactionally with `foreign_keys=ON`.
- Preserved execution/step/log/binding/audit rows, named indexes, execution cascade behavior, binding `execution_id` set-null behavior, and binding-to-audit cascade behavior.
- Updated the Drizzle `executions.chatRunId` declaration to match the migrated database.
- Did not seed global chat runs, disable foreign keys, or change authenticated admission and owner checks.

## TDD evidence

RED command:

```text
node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts electron/main/database/database.test.ts -t "migrates v12 executions to opaque user-cache chat-run correlation"
```

Before migration 0013, the focused test failed at the production execution repository insert with `SqliteError: FOREIGN KEY constraint failed` (1 failed, 105 skipped). The fixture also records that the same insert is rejected by raw schema v12.

GREEN evidence:

- Focused boundary regression: 1 passed, 105 skipped.
- Full database suite: 106 passed.
- With Task 8's authorized per-UID fixture migration present in the working tree, the ExecutionService plus Agent workflow integration suites: 92 passed across 2 files. This count is not reproducible from commit `a95c721` alone because that fixture migration is intentionally reserved for Task 8.
- Desktop typecheck: `tsc --noEmit -p tsconfig.node.json && vue-tsc --noEmit -p tsconfig.web.json` exited 0.
- Focused ESLint for the changed TypeScript files exited 0.

## Migration proof

The v12 regression fixture seeds one row in each of `executions`, `execution_steps`, `execution_logs`, `browser_tab_bindings`, and `browser_action_audits`, snapshots every column, opens through the production migration runner, and compares all pre-existing rows after migration. It then proves:

- a non-global per-UID run ID inserts, reads, and updates without a shadow `chat_runs` row;
- `PRAGMA foreign_key_list(executions)` has no `chat_runs` reference;
- `PRAGMA foreign_key_check` is empty after migration and after cascade operations;
- deleting an execution cascades its step and log and sets the binding execution ID to null;
- deleting the binding cascades its audit;
- all rebuilt named indexes remain present.
