import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareProductionStagingPlan } from '../../scripts/converter-packs/prepare-production-staging.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'autoforge-prepare-staging-')))
  temporaryRoots.push(root)
  return root
}

function executable(path: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'fixture')
  chmodSync(path, 0o755)
  return path
}

describe('production staging plan preparation', () => {
  it('maps verified acquisitions and native helpers to the exact four-family contract', async () => {
    const root = temporaryRoot()
    const helpers = join(root, 'helpers')
    const plan = join(root, 'staging-plan.json')
    const workspace = join(root, 'prepared')
    const staging = join(root, 'staging')
    const lock = join(root, 'sources.lock.json')
    const cache = join(root, 'cache')
    mkdirSync(cache)
    writeFileSync(lock, '{}')
    const imageHelper = executable(join(helpers, 'bin', 'autoforge-image-converter'))
    const pdfHelper = executable(join(helpers, 'bin', 'autoforge-pdf-raster'))
    const documentHelper = executable(join(helpers, 'program', 'soffice'))
    const engineFiles = Object.fromEntries(['ffmpeg', 'ffprobe', 'vips', 'pdfinfo', 'pdftocairo'].map((name) => [name, executable(join(root, 'engines', name))]))
    const licenses = Object.fromEntries(['ffmpeg', 'libreoffice', 'libvips', 'poppler'].map((name) => {
      const path = join(root, 'licenses', `${name}.txt`)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, `${name} license`)
      return [name, path]
    }))
    const libreOfficeDmg = join(root, 'LibreOffice.dmg')
    writeFileSync(libreOfficeDmg, 'dmg')
    const acquired = {
      target: 'darwin-arm64',
      engines: ['ffmpeg', 'libreoffice', 'libvips', 'poppler'].map((name) => ({
        name,
        acquisition: { archive: { path: name === 'libreoffice' ? libreOfficeDmg : join(root, `${name}.tar`) } },
      })),
    }

    await prepareProductionStagingPlan({
      lockPath: lock,
      target: 'darwin-arm64',
      cacheRoot: cache,
      helpersRoot: helpers,
      workspace,
      staging,
      planPath: plan,
      version: '1.2.3',
      sequence: 7,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs/releases/7',
    }, {
      acquireSources: async () => acquired,
      prepareEngine: async ({ engine }: { engine: { name: string } }) => ({
        executables: engine.name === 'ffmpeg'
          ? { ffmpeg: engineFiles.ffmpeg, ffprobe: engineFiles.ffprobe }
          : engine.name === 'libvips'
            ? { vips: engineFiles.vips }
            : engine.name === 'poppler'
              ? { pdfinfo: engineFiles.pdfinfo, pdftocairo: engineFiles.pdftocairo }
              : {},
        licensePath: licenses[engine.name],
      }),
    })

    const value = JSON.parse(readFileSync(plan, 'utf8'))
    expect(Object.keys(value.families)).toEqual(['document', 'image-icon', 'media', 'pdf'])
    expect(value).toMatchObject({
      target: 'darwin-arm64', output: staging, version: '1.2.3', sequence: 7,
      generatedAt: '2026-08-31T00:00:00.000Z',
      archiveBaseUrl: 'https://cdn.example.test/converter-packs/releases/7',
    })
    expect(value.families['image-icon'].entrypoints).toEqual([
      { source: imageHelper, destination: 'bin/autoforge-image-converter' },
      { source: engineFiles.vips, destination: 'bin/vips' },
    ])
    expect(value.families.document.entrypoints).toEqual([{ source: documentHelper, destination: 'program/soffice' }])
    expect(value.families.document.assets).toContainEqual({ source: libreOfficeDmg, destination: 'share/LibreOffice.dmg', role: 'data' })
    expect(value.families.pdf.entrypoints.map((entry: { destination: string }) => entry.destination)).toEqual([
      'bin/autoforge-pdf-raster', 'bin/pdfinfo', 'bin/pdftocairo',
    ])
    expect(value.families.pdf.entrypoints[0].source).toBe(pdfHelper)
    expect(value.families.media.entrypoints.map((entry: { destination: string }) => entry.destination)).toEqual(['bin/ffmpeg', 'bin/ffprobe'])
  })
})
