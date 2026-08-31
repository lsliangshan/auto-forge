import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { validateConverterPackWorkflows } from '../../scripts/converter-packs/validate-workflows.mjs'

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const checkPath = join(repositoryRoot, '.github', 'workflows', 'converter-pack-check.yml')
const releasePath = join(repositoryRoot, '.github', 'workflows', 'converter-pack-release.yml')

describe('converter pack workflows', () => {
  it('keeps pull-request validation credential-free and release publication protected', async () => {
    await expect(validateConverterPackWorkflows({ checkPath, releasePath })).resolves.toBeUndefined()

    const check = parse(readFileSync(checkPath, 'utf8'))
    const release = parse(readFileSync(releasePath, 'utf8'))
    expect(check.permissions).toEqual({ contents: 'read' })
    expect(check.on).toHaveProperty('pull_request')
    expect(JSON.stringify(check)).not.toContain('secrets.')
    expect(release.permissions).toEqual({ contents: 'read' })
    expect(release.on.workflow_dispatch.inputs.version.required).toBe(true)
    expect(release.on.workflow_dispatch.inputs.sequence.required).toBe(true)
    expect(release.jobs.stage_arm64['runs-on']).toBe('macos-15')
    expect(release.jobs.stage_arm64.env.AUTOFORGE_CONVERTER_TARGET).toBe('darwin-arm64')
    expect(release.jobs.stage_x64['runs-on']).toBe('macos-15-intel')
    expect(release.jobs.stage_x64.env.AUTOFORGE_CONVERTER_TARGET).toBe('darwin-x64')
    expect(release.jobs.production.environment).toBe('production')
    expect(release.jobs.production.needs).toEqual(['stage_arm64', 'stage_x64'])
    expect(JSON.stringify(release.jobs.stage_arm64)).not.toContain('secrets.')
    expect(JSON.stringify(release.jobs.stage_x64)).not.toContain('secrets.')
    expect(JSON.stringify(release.jobs.production)).toContain('secrets.')
  })

  it('pins every action, bounds artifacts, and invokes the complete tested CLI chain', () => {
    const source = `${readFileSync(checkPath, 'utf8')}\n${readFileSync(releasePath, 'utf8')}`
    const actions = [...source.matchAll(/^\s*-\s+uses:\s*([^\s#]+).*$/gmu)].map((match) => match[1]!)
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((action) => /@[a-f0-9]{40}$/u.test(action))).toBe(true)
    expect(source).toContain('retention-days: 1')
    for (const command of [
      'converter-packs:verify-workflows',
      'converter-packs:verify-sources',
      'converter-packs:acquire',
      'converter-packs:build-native',
      'converter-packs:prepare-staging',
      'converter-packs:stage',
      'converter-packs:sign-payload',
      'converter-packs:verify-evidence',
      'converter-packs:build',
      'converter-packs:sign',
      'verify:converter-packs',
      'converter-packs:publish',
      'converter-packs:create-bootstrap',
      'dist:production',
    ]) expect(source).toContain(command)
    expect(source).toContain('actions/upload-artifact@')
    expect(source).toContain('actions/download-artifact@')
    expect(source).toContain('if: always()')
  })
})
