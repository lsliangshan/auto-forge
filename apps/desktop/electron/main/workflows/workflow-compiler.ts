import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

type WorkflowCompiler = typeof import('esbuild')['build']

interface WorkflowCompilerOptions {
  resourcesPath?: string
}

export function loadWorkflowCompiler(options: WorkflowCompilerOptions = {}): WorkflowCompiler {
  const resourcesPath = options.resourcesPath
    ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const unpackedPackage = resourcesPath
    ? join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'esbuild', 'package.json')
    : undefined
  const runtimeRequire = createRequire(unpackedPackage && existsSync(unpackedPackage) ? unpackedPackage : import.meta.url)
  return (runtimeRequire('esbuild') as { build: WorkflowCompiler }).build
}
