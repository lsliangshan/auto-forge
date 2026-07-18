import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve('resources/templates/automation-tool-template')
const requiredFiles = [
  'manifest.json',
  'package.json',
  'tsconfig.json',
  'README.md',
  'src/index.ts',
  'dist/index.js',
  'dist/index.d.ts'
]

await Promise.all(requiredFiles.map((file) => access(resolve(root, file))))

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
if (manifest.entry !== 'dist/index.js') {
  throw new Error('Template manifest entry must point to dist/index.js')
}

console.log(`Template verified: ${requiredFiles.length} required files present.`)
