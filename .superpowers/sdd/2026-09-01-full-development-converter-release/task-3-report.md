# Task 3 report: local development release preparation

## Changes

- Added `prepare-local-development-release.mjs`, which fingerprints an explicit source allowlist, performs cold helper/plan/stage/build/verify/activate orchestration, and reuses only verified releases.
- The fingerprint walk rejects symbolic inputs and records portable paths sorted by UTF-8 bytes.
- Added injected-dependency integration coverage for cold/warm paths, corrupt-release replacement, marker retention, source-cache preservation, target/input fingerprinting, and safe callback paths.

## RED / GREEN

- RED: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts tests/integration/local-development-release-preparation.test.ts` failed as expected because `prepare-local-development-release.mjs` did not exist.
- GREEN: `pnpm --filter @autoforge/desktop exec vitest run --config vitest.node.config.ts tests/integration/local-development-release-preparation.test.ts tests/integration/converter-pack-acquisition.test.ts tests/integration/converter-pack-staging.test.ts tests/integration/converter-pack-tooling.test.ts` passed: 64 passed, 1 skipped.
- Syntax / whitespace: `node --check apps/desktop/scripts/converter-packs/prepare-local-development-release.mjs` and `git diff --check` passed.

## Commit

- `build: prepare complete development converter release` (commit ID is supplied in the task handoff).

## Remaining risk

- By controller decision, `create-local-development-image-release.mjs`, its package `predev` reference, and the legacy image-only integration test remain for Task 4. This task therefore does not claim the Step 7 no-reference `rg` check as GREEN.
- Same-OS-user concurrent modification of the local development cache remains outside the threat model.
