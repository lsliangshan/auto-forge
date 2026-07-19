import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace', () => {
  it('declares every production package and the required verification scripts', async () => {
    const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(root.packageManager).toBe('pnpm@11.15.0')
    expect(root.scripts).toMatchObject({
      lint: 'eslint .',
      typecheck: 'pnpm -r --if-present typecheck',
      test: 'vitest run',
      build: 'pnpm -r --filter "./packages/**" build && pnpm --filter @autoforge/desktop build',
    })
  })
})
