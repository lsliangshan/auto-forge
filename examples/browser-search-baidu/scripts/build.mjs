import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(fileURLToPath(new globalThis.URL('../package.json', import.meta.url)))
const sourceManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  external: ['@autoforge/workflow-sdk'],
  legalComments: 'none',
  logLevel: 'silent',
})
const output = result.outputFiles[0].contents
const manifest = {
  ...sourceManifest,
  entryPath: 'dist/index.js',
  codeSha256: createHash('sha256').update(output).digest('hex'),
}
await mkdir(join(root, 'dist'), { recursive: true })
await writeFile(join(root, 'dist/index.js'), output)
const serialized = `${JSON.stringify(manifest, null, 2)}\n`
await Promise.all([
  writeFile(join(root, 'manifest.json'), serialized),
  writeFile(join(root, 'workflow.json'), serialized),
])
