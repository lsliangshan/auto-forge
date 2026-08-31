import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { parseArguments, requireAbsolutePath } from './pack-tooling-lib.mjs'

const desktopRoot = fileURLToPath(new URL('../..', import.meta.url))
const nativeRoot = join(desktopRoot, 'converter-packs', 'native')
const targetArchitectures = Object.freeze({
  'darwin-arm64': 'arm64',
  'darwin-x64': 'x86_64',
})
const helpers = Object.freeze([
  Object.freeze({
    name: 'autoforge-image-converter',
    destination: 'bin/autoforge-image-converter',
    sources: [
      'common/arguments.c',
      'common/process.c',
      'image-converter/icon-container.c',
      'image-converter/main.c',
    ],
    includes: ['common', 'image-converter'],
  }),
  Object.freeze({
    name: 'autoforge-pdf-raster',
    destination: 'bin/autoforge-pdf-raster',
    sources: ['common/arguments.c', 'common/process.c', 'pdf-raster/main.c'],
    includes: ['common'],
  }),
  Object.freeze({
    name: 'autoforge-soffice-launcher',
    destination: 'program/soffice',
    sources: ['common/process.c', 'soffice-launcher/main.c'],
    includes: ['common'],
  }),
])

async function requireExecutable(path) {
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0 || await realpath(path) !== path) {
    throw new Error('Compiler must be one executable regular file without symbolic path components.')
  }
}

export async function buildNativeHelpers({ target, output, compiler }) {
  const architecture = targetArchitectures[target]
  if (!architecture) throw new Error('Target must be darwin-arm64 or darwin-x64.')
  requireAbsolutePath(output, 'Output')
  requireAbsolutePath(compiler, 'Compiler')
  await requireExecutable(compiler)
  if (await realpath(dirname(output)).catch(() => undefined) !== dirname(output)) {
    throw new Error('Output parent must be one canonical directory without symbolic path components.')
  }

  await mkdir(output, { mode: 0o755 })
  try {
    const bin = join(output, 'bin')
    await mkdir(bin, { mode: 0o755 })
    for (const helper of helpers) {
      const executable = join(output, ...helper.destination.split('/'))
      await mkdir(dirname(executable), { recursive: true, mode: 0o755 })
      const args = [
        '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
        '-mmacosx-version-min=11.0', '-arch', architecture,
        ...helper.sources.map((source) => join(nativeRoot, source)),
        ...helper.includes.flatMap((include) => ['-I', join(nativeRoot, include)]),
        '-o', executable,
      ]
      const result = spawnSync(compiler, args, { encoding: 'utf8', env: Object.freeze({ PATH: '/usr/bin:/bin' }) })
      if (result.status !== 0) throw new Error(`Native helper build failed: ${result.stderr || 'compiler exited unsuccessfully'}`)
      const metadata = await lstat(executable)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Compiler did not produce a regular helper executable.')
      await chmod(executable, 0o755)
    }
    return helpers.map(({ destination }) => join(output, ...destination.split('/')))
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

async function main(argv) {
  const args = parseArguments(argv, ['--target', '--output', '--compiler'])
  await buildNativeHelpers({
    target: args['--target'],
    output: args['--output'],
    compiler: args['--compiler'],
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
