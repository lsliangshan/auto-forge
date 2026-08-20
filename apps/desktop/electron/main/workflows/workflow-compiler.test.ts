import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadWorkflowCompiler } from './workflow-compiler.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('loadWorkflowCompiler', () => {
  it('loads the packaged compiler from app.asar.unpacked so its executable path stays physical', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'autoforge-packaged-compiler-'))
    temporaryDirectories.push(resourcesPath)
    const packageRoot = join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'esbuild')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'esbuild', main: 'index.cjs' }))
    await writeFile(join(packageRoot, 'index.cjs'), 'module.exports = { build: async () => ({ packagedCompiler: true }) }')

    const build = loadWorkflowCompiler({ resourcesPath })

    await expect(build({ stdin: { contents: 'const answer: number = 42', loader: 'ts' } }))
      .resolves.toMatchObject({ packagedCompiler: true })
  })
})
