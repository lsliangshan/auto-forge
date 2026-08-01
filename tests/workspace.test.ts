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
      test: 'node apps/desktop/scripts/run-vitest-electron.mjs run',
      build: 'pnpm -r --filter "./packages/**" build && pnpm --filter @autoforge/desktop build',
    })
    expect(desktop.scripts).toMatchObject({
      predev: 'pnpm prepare:native-electron',
      pretest: 'pnpm prepare:native-electron',
      test: 'node scripts/run-vitest-electron.mjs run --config vitest.config.ts && node scripts/run-vitest-electron.mjs run --config vitest.node.config.ts',
      'prepare:native-electron': 'install-electron && node scripts/prepare-native-electron.mjs',
    })
    await expect(access(new URL(
      '../apps/desktop/scripts/prepare-native-node.mjs',
      import.meta.url,
    ))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
