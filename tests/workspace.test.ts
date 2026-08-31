import { spawnSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace', () => {
  it('declares every production package and the required verification scripts', async () => {
    const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const desktop = JSON.parse(await readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'))
    expect(root.packageManager).toBe('pnpm@11.15.0')
    expect(root.scripts).toMatchObject({
      lint: 'eslint .',
      pretest: 'pnpm --filter @autoforge/desktop prepare:native-electron',
      typecheck: 'pnpm -r --if-present typecheck',
      test: 'node apps/desktop/scripts/run-vitest-electron.mjs run && vitest run --config vitest.cloud-runtime.config.ts',
      build: 'pnpm -r --filter "./packages/**" build && pnpm --filter @autoforge/desktop build && pnpm build:e2e:cloud-user-data-sync && pnpm build:e2e:knowledge-smoke && pnpm build:e2e:knowledge-benchmark && pnpm build:e2e:universal-file-converter',
      'build:e2e:cloud-user-data-sync': 'pnpm --filter @autoforge/desktop exec tsup electron/e2e/cloud-user-data-sync-main.ts --format esm --platform node --external electron --external better-sqlite3 --loader .sql=text --out-dir .e2e/main --clean false',
      'build:e2e:knowledge-smoke': 'pnpm --filter @autoforge/desktop exec tsup electron/e2e/knowledge-smoke-main.ts --format esm --platform node --external electron --external better-sqlite3 --loader .sql=text --out-dir .e2e/main --clean false',
      'build:e2e:knowledge-benchmark': 'pnpm --filter @autoforge/desktop exec tsup electron/e2e/knowledge-benchmark-main.ts --format esm --platform node --external electron --external better-sqlite3 --external better-sqlite3-multiple-ciphers --loader .sql=text --out-dir .e2e/main --clean false',
      'test:knowledge:evaluation': 'AUTOFORGE_KNOWLEDGE_BENCHMARK=1 pnpm --filter @autoforge/desktop exec node scripts/run-vitest-electron.mjs run electron/main/knowledge/evaluation/knowledge-evaluation.test.ts electron/main/knowledge/evaluation/knowledge-benchmark.test.ts --config vitest.node.config.ts',
      'test:e2e:knowledge': 'pnpm build && playwright test apps/desktop/tests/e2e/knowledge-smoke.spec.ts',
      'test:e2e:knowledge-benchmark': 'pnpm build && playwright test apps/desktop/tests/e2e/knowledge-benchmark.spec.ts',
      'build:e2e:universal-file-converter': 'pnpm --filter @autoforge/desktop exec tsup tests/e2e/universal-file-converter-fixture.ts --format esm --platform node --external electron --external better-sqlite3 --loader .sql=text --out-dir .e2e/main --clean false',
    })
    expect(desktop.scripts).toMatchObject({
      predev: 'pnpm prepare:native-electron && node scripts/converter-packs/create-local-development-image-release.mjs',
      pretest: 'pnpm prepare:native-electron',
      test: 'node scripts/run-vitest-electron.mjs run --config vitest.config.ts && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts',
      'prepare:native-electron': 'install-electron && node scripts/prepare-native-electron.mjs',
    })
    await expect(access(new URL(
      '../apps/desktop/scripts/prepare-native-node.mjs',
      import.meta.url,
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('loads the CloudBase SDK without missing runtime dependency warnings', () => {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('@cloudbase/js-sdk')"],
      {
        cwd: new URL('../apps/desktop/', import.meta.url),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          ...(process.env.ELECTRON_RUN_AS_NODE
            ? { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }
            : {}),
        },
      },
    )

    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toContain('缺少依赖 ws')
  })
})
