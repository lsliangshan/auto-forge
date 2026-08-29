import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('native package target path validation', () => {
  it('accepts Windows drive and UNC package roots independently of the fixture host', () => {
    const modulePath = fileURLToPath(new URL('../../../scripts/native-package-paths.mjs', import.meta.url))
    const program = `
      import { isAbsoluteNativePackagePath } from ${JSON.stringify(`file://${modulePath}`)};
      const values = [
        isAbsoluteNativePackagePath('C:\\\\release\\\\AutoForge', 'win32'),
        isAbsoluteNativePackagePath('\\\\\\\\server\\\\share\\\\AutoForge', 'win32'),
        isAbsoluteNativePackagePath('C:release\\\\AutoForge', 'win32'),
        isAbsoluteNativePackagePath('\\\\\\\\?\\\\C:\\\\device', 'win32'),
      ];
      if (JSON.stringify(values) !== JSON.stringify([true, true, false, false])) process.exit(2);
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })
})
