import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const builderConfigPath = fileURLToPath(new URL('../../electron-builder.yml', import.meta.url))
const localRequire = createRequire(import.meta.url)
const electronBuilderRequire = createRequire(localRequire.resolve('electron-builder/package.json'))
const { FileMatcher } = electronBuilderRequire('app-builder-lib/out/fileMatcher') as {
  FileMatcher: new (
    from: string,
    to: string,
    macroExpander: (pattern: string) => string,
    patterns: string[],
  ) => { createFilter(): (file: string, fileStat: Awaited<ReturnType<typeof stat>>) => boolean }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function configuredFilePatterns(): Promise<string[]> {
  const config = await readFile(builderConfigPath, 'utf8')
  const block = /^files:\s*\n((?: {2}-[^\n]*(?:\n|$))+)/mu.exec(config)?.[1]
  if (!block) throw new Error('electron-builder files configuration is missing')
  return block.trimEnd().split('\n').map(line => (
    line.replace(/^ {2}-\s*/u, '').replace(/^(['"])(.*)\1$/u, '$2')
  ))
}

describe('production package contents', () => {
  it('excludes a stale smoke bundle and its test-only release material from actual builder file inputs', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'autoforge-package-content-'))
    directories.push(fixture)
    const productionEntry = join(fixture, 'out', 'main', 'index.js')
    const staleSmokeEntry = join(fixture, 'out', 'e2e', 'knowledge-ui-smoke-main.js')
    await mkdir(join(fixture, 'out', 'main'), { recursive: true })
    await mkdir(join(fixture, 'out', 'e2e'), { recursive: true })
    await writeFile(productionEntry, 'production entry')
    await writeFile(staleSmokeEntry, 'approvedEvaluationCorpus:true;smoke-only-key')
    const filter = new FileMatcher(
      fixture,
      join(fixture, 'app'),
      pattern => pattern,
      await configuredFilePatterns(),
    ).createFilter()
    const candidates = [productionEntry, staleSmokeEntry]
    const included = []
    for (const candidate of candidates) {
      if (filter(candidate, await stat(candidate))) included.push(candidate)
    }

    expect(included.map(file => relative(fixture, file))).toEqual(['out/main/index.js'])
    const packagedInput = (await Promise.all(included.map(file => readFile(file, 'utf8')))).join('\n')
    expect(packagedInput).not.toContain('approvedEvaluationCorpus:true')
    expect(packagedInput).not.toContain('smoke-only-key')
  })
})
