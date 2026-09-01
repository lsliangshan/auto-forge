import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { acquireConverterSources } from './acquire-sources.mjs'
import {
  canonicalBytes,
  fail,
  isPathInsideRoot,
  parseArguments,
  requireAbsolutePath,
  requireDirectory,
} from './pack-tooling-lib.mjs'

const executableSuffixes = Object.freeze({
  ffmpeg: Object.freeze({ ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' }),
  libvips: Object.freeze({ vips: '/bin/vips' }),
  poppler: Object.freeze({ pdfinfo: '/bin/pdfinfo', pdftocairo: '/bin/pdftocairo' }),
})
const licenseNames = Object.freeze({
  ffmpeg: Object.freeze(['COPYING.GPLv3', 'COPYING.GPLv2', 'LICENSE.md']),
  libreoffice: Object.freeze(['COPYING', 'LICENSE']),
  libvips: Object.freeze(['COPYING', 'LICENSE']),
  poppler: Object.freeze(['COPYING', 'COPYING3', 'LICENSE']),
})
const maximumSourceLicenseWrappers = 64
const maximumSourceLicenseCandidates = 32

async function extractArchive(archive, output) {
  requireAbsolutePath(archive, 'Verified archive')
  await mkdir(output, { mode: 0o700 })
  const result = spawnSync('/usr/bin/tar', ['-xf', archive, '-C', output, '--no-same-owner', '--no-same-permissions'], {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) fail('Verified converter archive extraction failed.')
}

async function collectRegularFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (files.length > 100_000) fail('Verified converter archive contains too many files.')
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else if (!entry.isSymbolicLink()) fail('Verified converter archive contains an unsupported file type.')
    }
  }
  await visit(root)
  return files
}

function uniqueSuffix(files, suffix, label) {
  const matches = files.filter((path) => path.endsWith(suffix))
  if (matches.length !== 1) fail(`${label} is missing or ambiguous in the verified runtime archive.`)
  return matches[0]
}

export async function selectVerifiedSourceLicense(root, names, label) {
  const rootMetadata = await lstat(root).catch(() => undefined)
  const canonicalRoot = await realpath(root).catch(() => undefined)
  if (!rootMetadata?.isDirectory() || rootMetadata.isSymbolicLink() || canonicalRoot !== root) {
    fail(`${label} source root must be a canonical directory and symbolic links are forbidden.`)
  }
  const acceptedNames = new Set(names)
  const candidates = []
  const byUtf8Name = (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name))
  const inspectEntries = async (directory, entries) => {
    for (const entry of entries) {
      if (!acceptedNames.has(entry.name)) continue
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (!entry.isFile() || !metadata.isFile()) {
        fail(`${label} license has an unsupported file type in the verified source archive.`)
      }
      candidates.push({ name: entry.name, path })
      if (candidates.length > maximumSourceLicenseCandidates) {
        fail(`${label} license has too many candidates in the verified source archive.`)
      }
    }
  }

  const rootEntries = (await readdir(root, { withFileTypes: true })).sort(byUtf8Name)
  await inspectEntries(root, rootEntries)
  if (rootEntries.some((entry) => entry.isSymbolicLink())) {
    fail(`${label} source wrappers must not use symbolic links.`)
  }
  const wrappers = rootEntries.filter((entry) => entry.isDirectory())
  if (wrappers.length > maximumSourceLicenseWrappers) {
    fail(`${label} license search has too many directories in the verified source archive.`)
  }
  for (const wrapper of wrappers) {
    const directory = join(root, wrapper.name)
    const metadata = await lstat(directory).catch(() => undefined)
    const resolved = await realpath(directory).catch(() => undefined)
    if (
      !metadata?.isDirectory()
      || metadata.isSymbolicLink()
      || resolved !== directory
      || !isPathInsideRoot(canonicalRoot, resolved)
    ) {
      fail(`${label} license search encountered an unsupported source wrapper.`)
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort(byUtf8Name)
    await inspectEntries(directory, entries)
  }

  for (const name of names) {
    const matches = candidates.filter((candidate) => candidate.name === name)
    if (matches.length === 0) continue
    matches.sort((left, right) => left.path.length - right.path.length || Buffer.from(left.path).compare(Buffer.from(right.path)))
    const selected = matches[0].path
    const metadata = await lstat(selected).catch(() => undefined)
    const resolved = await realpath(selected).catch(() => undefined)
    if (
      !metadata?.isFile()
      || metadata.isSymbolicLink()
      || resolved !== selected
      || !isPathInsideRoot(canonicalRoot, resolved)
    ) {
      fail(`${label} license must resolve to a canonical regular file inside the verified source root.`)
    }
    return resolved
  }
  fail(`${label} license is missing from the verified source archive.`)
}

async function defaultPrepareEngine({ engine, workspace }) {
  const sourceRoot = join(workspace, 'sources', engine.name)
  await mkdir(dirname(sourceRoot), { recursive: true, mode: 0o700 })
  await extractArchive(engine.sourceArchive.path, sourceRoot)
  const licensePath = await selectVerifiedSourceLicense(sourceRoot, licenseNames[engine.name], engine.name)
  if (engine.name === 'libreoffice') return { executables: {}, licensePath }
  const runtimeRoot = join(workspace, 'runtime', engine.name)
  await mkdir(dirname(runtimeRoot), { recursive: true, mode: 0o700 })
  await extractArchive(engine.acquisition.archive.path, runtimeRoot)
  const runtimeFiles = await collectRegularFiles(runtimeRoot)
  const executables = Object.fromEntries(Object.entries(executableSuffixes[engine.name]).map(([name, suffix]) => (
    [name, uniqueSuffix(runtimeFiles, suffix, engine.name)]
  )))
  return { executables, licensePath }
}

const productionDependencies = Object.freeze({
  acquireSources: (request) => acquireConverterSources(request),
  prepareEngine: defaultPrepareEngine,
})

function requireEngine(map, name) {
  const engine = map.get(name)
  if (engine === undefined) fail(`Verified converter acquisition is missing: ${name}`)
  return engine
}

export async function prepareProductionStagingPlan(request, dependencies = productionDependencies) {
  for (const [value, label] of [
    [request.lockPath, 'Source lock'], [request.cacheRoot, 'Source cache'], [request.helpersRoot, 'Native helpers'],
    [request.workspace, 'Preparation workspace'], [request.staging, 'Staging output'], [request.planPath, 'Staging plan'],
  ]) requireAbsolutePath(value, label)
  if (request.target !== 'darwin-arm64' && request.target !== 'darwin-x64') fail('Staging preparation target is unsupported.')
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 0) fail('Staging preparation sequence is invalid.')
  if (typeof dependencies?.acquireSources !== 'function' || typeof dependencies?.prepareEngine !== 'function') {
    fail('Staging preparation dependencies are invalid.')
  }
  await Promise.all([
    requireDirectory(request.cacheRoot, 'Source cache'),
    requireDirectory(request.helpersRoot, 'Native helpers'),
  ])
  if (await realpath(dirname(request.workspace)).catch(() => undefined) !== dirname(request.workspace)) {
    fail('Preparation workspace parent must be canonical.')
  }
  await mkdir(request.workspace, { mode: 0o700 })
  try {
    const acquired = await dependencies.acquireSources({
      lockPath: request.lockPath, target: request.target, cacheRoot: request.cacheRoot,
    })
    if (acquired?.target !== request.target || !Array.isArray(acquired.engines) || acquired.engines.length !== 4) {
      fail('Verified converter acquisition inventory is invalid.')
    }
    const engines = new Map(acquired.engines.map((engine) => [engine.name, engine]))
    if (engines.size !== 4) fail('Verified converter acquisition inventory is invalid.')
    const prepared = new Map()
    for (const name of ['ffmpeg', 'libreoffice', 'libvips', 'poppler']) {
      const engine = requireEngine(engines, name)
      const result = await dependencies.prepareEngine({ engine, workspace: request.workspace })
      if (typeof result?.licensePath !== 'string' || typeof result?.executables !== 'object' || result.executables === null) {
        fail(`Prepared converter engine is invalid: ${name}`)
      }
      prepared.set(name, result)
    }
    const ffmpeg = prepared.get('ffmpeg')
    const libreoffice = prepared.get('libreoffice')
    const libvips = prepared.get('libvips')
    const poppler = prepared.get('poppler')
    const libreOfficeDmg = requireEngine(engines, 'libreoffice').acquisition?.archive?.path
    requireAbsolutePath(libreOfficeDmg, 'LibreOffice DMG')
    const license = (name, source) => ({ source, destination: `licenses/${name}.txt`, role: 'license' })
    const value = {
      target: request.target,
      output: request.staging,
      version: request.version,
      sequence: request.sequence,
      generatedAt: request.generatedAt,
      archiveBaseUrl: request.archiveBaseUrl,
      families: {
        'image-icon': {
          entrypoints: [
            { source: join(request.helpersRoot, 'bin', 'autoforge-image-converter'), destination: 'bin/autoforge-image-converter' },
            { source: libvips.executables.vips, destination: 'bin/vips' },
          ],
          assets: [license('libvips', libvips.licensePath)],
        },
        document: {
          entrypoints: [{ source: join(request.helpersRoot, 'program', 'soffice'), destination: 'program/soffice' }],
          assets: [
            { source: libreOfficeDmg, destination: 'share/LibreOffice.dmg', role: 'data' },
            license('libreoffice', libreoffice.licensePath),
          ],
        },
        pdf: {
          entrypoints: [
            { source: join(request.helpersRoot, 'bin', 'autoforge-pdf-raster'), destination: 'bin/autoforge-pdf-raster' },
            { source: poppler.executables.pdfinfo, destination: 'bin/pdfinfo' },
            { source: poppler.executables.pdftocairo, destination: 'bin/pdftocairo' },
          ],
          assets: [license('poppler', poppler.licensePath)],
        },
        media: {
          entrypoints: [
            { source: ffmpeg.executables.ffmpeg, destination: 'bin/ffmpeg' },
            { source: ffmpeg.executables.ffprobe, destination: 'bin/ffprobe' },
          ],
          assets: [license('ffmpeg', ffmpeg.licensePath)],
        },
      },
    }
    if (isPathInsideRoot(request.staging, request.planPath)) fail('Staging plan must remain outside staging output.')
    await writeFile(request.planPath, canonicalBytes(value), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rm(request.workspace, { recursive: true, force: true })
    throw error
  }
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const args = parseArguments(process.argv.slice(2), [
    '--lock', '--target', '--cache', '--helpers', '--workspace', '--staging', '--plan',
    '--version', '--sequence', '--generated-at', '--archive-base-url',
  ])
  if (!/^(?:0|[1-9]\d*)$/u.test(args['--sequence'])) fail('Staging preparation sequence is invalid.')
  await prepareProductionStagingPlan({
    lockPath: args['--lock'], target: args['--target'], cacheRoot: args['--cache'], helpersRoot: args['--helpers'],
    workspace: args['--workspace'], staging: args['--staging'], planPath: args['--plan'], version: args['--version'],
    sequence: Number(args['--sequence']), generatedAt: args['--generated-at'], archiveBaseUrl: args['--archive-base-url'],
  })
  process.stdout.write('prepared verified converter pack staging plan\n')
}
