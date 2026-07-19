import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate'
import { parseWorkflowManifest, type WorkflowManifest } from '@autoforge/workflow-contracts'

const allowedFiles = new Set(['workflow.json', 'README.md', 'tsconfig.json', 'sdk/index.d.ts', 'src/index.ts'])
const sourceLimit = 2 * 1024 * 1024

export interface BuiltWorkflow {
  manifest: WorkflowManifest
  source: string
  code: Buffer
  codeSha256: string
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function validateImports(source: string): void {
  const imports = source.matchAll(/(?:import|export)\s+(?!type\b)[\s\S]*?\sfrom\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(/g)
  for (const match of imports) {
    throw new Error(`Runtime import is not allowed: ${match[1] ?? match[2] ?? 'require'}`)
  }
  for (const match of source.matchAll(/import\s+type[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    if (match[1] !== '@autoforge/workflow-sdk') throw new Error(`Type import is not allowed: ${match[1]}`)
  }
}

export async function buildWorkflowSource(source: string, manifest: WorkflowManifest): Promise<BuiltWorkflow> {
  if (Buffer.byteLength(source) > sourceLimit) throw new Error('Entry source exceeds 2 MB')
  validateImports(source)
  if (!/export\s+(?:async\s+)?function\s+run\b|export\s+(?:const|let|var)\s+run\b/.test(source)) {
    throw new Error('Workflow must export run(context)')
  }
  const result = await build({
    stdin: { contents: source, sourcefile: 'src/index.ts', loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    legalComments: 'none',
    minify: false,
    sourcemap: false
  })
  const code = Buffer.from(result.outputFiles[0].contents)
  return { manifest, source, code, codeSha256: sha256(code) }
}

export async function buildSourceArchive(archive: Uint8Array): Promise<BuiltWorkflow> {
  if (archive.byteLength > 10 * 1024 * 1024) throw new Error('Source archive exceeds 10 MB')
  const entries = unzipSync(archive)
  for (const file of Object.keys(entries)) {
    if (file.startsWith('/') || file.includes('..') || file.includes('\\') || !allowedFiles.has(file)) {
      throw new Error(`Archive contains disallowed path: ${file}`)
    }
  }
  for (const required of allowedFiles) if (!entries[required]) throw new Error(`Archive is missing ${required}`)
  const manifest = parseWorkflowManifest(JSON.parse(strFromU8(entries['workflow.json'])))
  return buildWorkflowSource(strFromU8(entries['src/index.ts']), manifest)
}

export function createReleaseArchive(manifest: WorkflowManifest, code: Uint8Array): Buffer {
  const entries: Record<string, Uint8Array> = {
    'dist/index.mjs': code,
    'workflow.json': strToU8(JSON.stringify(manifest))
  }
  return Buffer.from(zipSync(entries, { level: 9, mtime: new Date('1980-01-01T00:00:00.000Z') }))
}

export function hashBuffer(value: Uint8Array): string {
  return sha256(value)
}
