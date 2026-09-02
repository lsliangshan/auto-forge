import { spawnSync } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { compareUtf8, fail, isPathInsideRoot, readStableRegularFile, requireAbsolutePath, safeEntryPath, sha256 } from './pack-tooling-lib.mjs'

const systemPrefixes = ['/usr/lib/', '/System/Library/']

function nonemptyLines(output) {
  if (typeof output !== 'string' || output.includes('\0')) fail('Mach-O inspection output is invalid.')
  return output.split(/\r?\n/u).filter((line) => line.length > 0)
}

export function parseOtoolLibraries(output) {
  const lines = nonemptyLines(output)
  if (lines.length === 0 || !lines[0].endsWith(':')) fail('otool library output is invalid.')
  return lines.slice(1).map((line) => {
    const match = /^\s+([^\s].*?) \(compatibility version [^\r\n]+, current version [^\r\n]+\)$/u.exec(line)
    if (!match) fail('otool library output is invalid.')
    return match[1]
  })
}

export function parseOtoolRpaths(output) {
  const lines = nonemptyLines(output)
  const rpaths = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== 'cmd LC_RPATH') continue
    let path
    for (let candidate = index + 1; candidate < Math.min(lines.length, index + 4); candidate += 1) {
      const match = /^\s*path (.+) \(offset [1-9]\d*\)$/u.exec(lines[candidate])
      if (match) {
        path = match[1]
        break
      }
    }
    if (path === undefined) fail('otool rpath output is invalid.')
    rpaths.push(path)
  }
  return rpaths
}

async function defaultRun(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function successfulRun(run, executable, args, label) {
  const result = await run(executable, args)
  if (
    !result
    || result.status !== 0
    || typeof result.stdout !== 'string'
    || typeof result.stderr !== 'string'
  ) fail(`${label} failed.`)
  return result.stdout
}

export async function inspectMachO(path, { run = defaultRun } = {}) {
  requireAbsolutePath(path, 'Mach-O path')
  const [architecturesOutput, librariesOutput, loadCommandsOutput] = await Promise.all([
    successfulRun(run, '/usr/bin/lipo', ['-archs', path], 'lipo inspection'),
    successfulRun(run, '/usr/bin/otool', ['-L', path], 'otool library inspection'),
    successfulRun(run, '/usr/bin/otool', ['-l', path], 'otool load-command inspection'),
  ])
  const architectures = architecturesOutput.trim().split(/\s+/u).filter(Boolean)
  if (architectures.length === 0 || architectures.some((architecture) => architecture !== 'arm64' && architecture !== 'x86_64')) {
    fail('Mach-O architecture output is invalid.')
  }
  return {
    architectures,
    dependencies: parseOtoolLibraries(librariesOutput),
    rpaths: parseOtoolRpaths(loadCommandsOutput),
  }
}

function systemDependency(path) {
  return typeof path === 'string'
    && posix.isAbsolute(path)
    && posix.normalize(path) === path
    && systemPrefixes.some((prefix) => path.startsWith(prefix))
}

function expandAnchor(value, sourceDirectory, executableDirectory) {
  if (value === '@loader_path') return sourceDirectory
  if (value.startsWith('@loader_path/')) return join(sourceDirectory, value.slice('@loader_path/'.length))
  if (value === '@executable_path') return executableDirectory
  if (value.startsWith('@executable_path/')) return join(executableDirectory, value.slice('@executable_path/'.length))
  if (isAbsolute(value)) return value
  return undefined
}

const cellarPlaceholder = /^@@HOMEBREW_CELLAR@@\/([a-z0-9][a-z0-9+_.@-]*)\/([A-Za-z0-9._+-]+)\/(.+)$/u
const prefixPlaceholder = /^@@HOMEBREW_PREFIX@@\/opt\/([a-z0-9][a-z0-9+_.@-]*)\/(.+)$/u

function lockedKey(formula, sourcePath) {
  return `${formula}\0${sourcePath}`
}

function pathKey(path) {
  return path.toLocaleLowerCase('en-US')
}

async function resolveDependency(dependency, inspection, node, locked) {
  if (systemDependency(dependency)) return undefined
  const cellar = cellarPlaceholder.exec(dependency)
  if (cellar) {
    const [, formula, version, sourcePath] = cellar
    const expected = locked.byFormulaPath.get(lockedKey(formula, sourcePath))
    if (!expected) fail('Mach-O dependency is not declared in the locked inventory.')
    locked.universe.cellar(formula, version)
    return expected
  }
  const prefix = prefixPlaceholder.exec(dependency)
  if (prefix) {
    const [, formula, sourcePath] = prefix
    const expected = locked.byFormulaPath.get(lockedKey(formula, sourcePath))
    if (!expected) fail('Mach-O dependency is not declared in the locked inventory.')
    locked.universe.opt(formula)
    return expected
  }
  if (dependency.includes('@@HOMEBREW_')) fail('Mach-O dependency contains an invalid Homebrew placeholder.')
  if (isAbsolute(dependency)) fail('Mach-O host absolute dependency is forbidden.')
  const sourceDirectory = dirname(node.source)
  if (dependency.startsWith('@rpath/')) {
    const suffix = dependency.slice('@rpath/'.length)
    for (const rpath of inspection.rpaths) {
      let base
      const cellarRpath = cellarPlaceholder.exec(rpath)
      const prefixRpath = prefixPlaceholder.exec(rpath)
      if (cellarRpath) {
        const [, formula, version, sourcePath] = cellarRpath
        base = join(locked.universe.cellar(formula, version), ...sourcePath.split('/'))
      } else if (prefixRpath) {
        const [, formula, sourcePath] = prefixRpath
        base = join(locked.universe.opt(formula), ...sourcePath.split('/'))
      } else {
        if (rpath.includes('@@HOMEBREW_') || isAbsolute(rpath)) continue
        base = expandAnchor(rpath, sourceDirectory, node.executableDirectory)
      }
      if (base === undefined) continue
      const candidate = locked.bySource.get(pathKey(join(base, suffix)))
      if (candidate !== undefined) return candidate
    }
    fail('Mach-O dependency is unresolved.')
  }
  const expanded = expandAnchor(dependency, sourceDirectory, node.executableDirectory)
  if (expanded === undefined) fail('Mach-O dependency is unresolved.')
  const candidate = locked.bySource.get(pathKey(expanded))
  if (candidate === undefined) fail('Mach-O dependency is unresolved.')
  return candidate
}

function validateInspection(value, architecture) {
  if (
    typeof value !== 'object'
    || value === null
    || !Array.isArray(value.architectures)
    || !Array.isArray(value.dependencies)
    || !Array.isArray(value.rpaths)
    || value.architectures.some((item) => typeof item !== 'string')
    || value.dependencies.some((item) => typeof item !== 'string' || item.length === 0)
    || value.rpaths.some((item) => typeof item !== 'string' || item.length === 0)
  ) fail('Mach-O inspection is invalid.')
  if (!value.architectures.includes(architecture)) fail('Mach-O architecture mismatch.')
  return value
}

function replacementFor(fromDestination, dependencyDestination) {
  const relative = posix.relative(posix.dirname(fromDestination), dependencyDestination)
  return `@loader_path/${relative}`
}

function packLocalLoaderDestination(destination, dependency) {
  if (!dependency.startsWith('@loader_path/') || dependency.includes('@@HOMEBREW_')) return undefined
  const suffix = dependency.slice('@loader_path/'.length)
  if (suffix.length === 0 || suffix.includes('\\') || suffix.includes('\0') || posix.isAbsolute(suffix)) return undefined
  const resolved = posix.normalize(posix.join(posix.dirname(destination), suffix))
  return safeEntryPath(resolved) ? resolved : undefined
}

async function requireCanonicalPayload(payload) {
  const metadata = await lstat(payload).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await realpath(payload).catch(() => undefined) !== payload) {
    fail('Mach-O payload must be a canonical non-symbolic directory.')
  }
  return payload
}

async function requirePayloadBinary(payload, destination, label) {
  const binary = join(payload, ...destination.split('/'))
  const metadata = await lstat(binary).catch(() => undefined)
  if (
    !isPathInsideRoot(payload, binary)
    || !metadata?.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || await realpath(binary).catch(() => undefined) !== binary
  ) fail(`${label} must be a canonical non-symbolic regular file.`)
  return binary
}

function validExpectedFile(file) {
  return file
    && typeof file === 'object'
    && typeof file.formula === 'string'
    && /^[a-z0-9][a-z0-9+_.@-]*$/u.test(file.formula)
    && safeEntryPath(file.sourcePath)
    && safeEntryPath(file.destination)
    && /^[a-f0-9]{64}$/u.test(file.sha256)
    && Number.isSafeInteger(file.bytes)
    && file.bytes > 0
    && typeof file.executable === 'boolean'
    && (file.role === 'executable' || file.role === 'code' || file.role === 'data')
    && (file.role === 'executable' ? file.executable : !file.executable)
}

function validExpectedRewrite(rewrite) {
  return rewrite
    && typeof rewrite === 'object'
    && safeEntryPath(rewrite.destination)
    && typeof rewrite.dependency === 'string'
    && rewrite.dependency.length > 0
    && typeof rewrite.replacement === 'string'
    && rewrite.replacement.startsWith('@loader_path/')
}

function rewriteKey(rewrite) {
  return `${rewrite.destination}\0${rewrite.dependency}\0${rewrite.replacement}`
}

export async function planMachOClosure({ entrypoints, architecture, inspect, universe, expectedFiles, expectedRewrites }) {
  if (
    !Array.isArray(entrypoints)
    || entrypoints.length === 0
    || (architecture !== 'arm64' && architecture !== 'x86_64')
    || typeof inspect !== 'function'
    || !universe
    || typeof universe.cellar !== 'function'
    || typeof universe.opt !== 'function'
    || typeof universe.resolveLockedFile !== 'function'
    || typeof universe.contains !== 'function'
    || !Array.isArray(expectedFiles)
    || expectedFiles.length === 0
    || expectedFiles.some((file) => !validExpectedFile(file))
    || !Array.isArray(expectedRewrites)
    || expectedRewrites.some((rewrite) => !validExpectedRewrite(rewrite))
  ) fail('Mach-O closure request is invalid.')

  const files = []
  const rewrites = []
  const discoveredSources = new Set()
  const byDestination = new Map()
  const queue = []
  const byFormulaPath = new Map()
  const bySource = new Map()
  const expectedRewriteKeys = new Set()

  for (const rewrite of expectedRewrites) {
    const key = rewriteKey(rewrite)
    if (expectedRewriteKeys.has(key)) fail('Mach-O locked rewrite inventory contains a duplicate.')
    expectedRewriteKeys.add(key)
  }

  for (const expected of expectedFiles) {
    const key = lockedKey(expected.formula, expected.sourcePath)
    if (byFormulaPath.has(key)) fail('Mach-O locked file inventory contains a duplicate.')
    const destinationKey = expected.destination.toLocaleLowerCase('en-US')
    if (byDestination.has(destinationKey)) fail(`Mach-O destination collision: ${expected.destination}`)
    if (!expected.executable) {
      const requiredDestination = expected.role === 'code'
        ? `lib/${expected.formula}/${posix.basename(expected.sourcePath)}`
        : undefined
      if (requiredDestination && expected.destination !== requiredDestination) {
        fail(`Mach-O library destination is not namespaced: ${expected.destination}`)
      }
    }
    const source = universe.resolveLockedFile(expected.formula, expected.sourcePath)
    requireAbsolutePath(source, 'Bottle universe file')
    if (!universe.contains(source)) fail('Mach-O locked source is outside the bottle universe.')
    const metadata = await lstat(source).catch(() => undefined)
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || await realpath(source).catch(() => undefined) !== source) {
      fail('Mach-O locked source must be a canonical non-symbolic regular file.')
    }
    const bytes = await readStableRegularFile(source, 'Mach-O locked source')
    if (bytes.byteLength !== expected.bytes) fail(`Mach-O locked file size differs: ${expected.destination}`)
    if (sha256(bytes) !== expected.sha256) fail(`Mach-O locked file hash differs: ${expected.destination}`)
    const node = { expected, source, destination: expected.destination, executable: expected.executable }
    byFormulaPath.set(key, node)
    if (bySource.has(pathKey(source))) fail('Mach-O locked source inventory contains a duplicate.')
    bySource.set(pathKey(source), node)
    byDestination.set(destinationKey, node)
  }

  const add = (node, executableDirectory) => {
    if (discoveredSources.has(node.source)) return node
    discoveredSources.add(node.source)
    node.executableDirectory = executableDirectory
    files.push({
      source: node.source,
      destination: node.destination,
      executable: node.executable,
      formula: node.expected.formula,
      role: node.expected.role,
    })
    queue.push(node)
    return node
  }

  for (const entrypoint of entrypoints) {
    if (typeof entrypoint !== 'object' || entrypoint === null) fail('Mach-O entrypoint is invalid.')
    const node = bySource.get(pathKey(entrypoint.source))
    if (!node || !node.executable || node.destination !== entrypoint.destination) fail('Mach-O entrypoint is not in the locked inventory.')
    add(node, dirname(node.source))
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor]
    if (node.expected.role === 'data') continue
    const inspection = validateInspection(await inspect(node.source), architecture)
    for (const dependency of inspection.dependencies) {
      const dependencyNode = await resolveDependency(dependency, inspection, node, { byFormulaPath, bySource, universe })
      if (dependencyNode === undefined) continue
      if (dependencyNode.source === node.source) continue
      add(dependencyNode, node.executableDirectory)
      rewrites.push({
        destination: node.destination,
        dependency,
        replacement: replacementFor(node.destination, dependencyNode.destination),
      })
    }
  }

  for (const node of byFormulaPath.values()) {
    if (node.expected.role === 'data') {
      if (!discoveredSources.has(node.source)) {
        discoveredSources.add(node.source)
        files.push({ source: node.source, destination: node.destination, executable: false, formula: node.expected.formula, role: 'data' })
      }
    } else if (!discoveredSources.has(node.source)) {
      fail(`Mach-O locked file is declared but unreachable: ${node.destination}`)
    }
  }

  files.sort((left, right) => compareUtf8(left.destination, right.destination))
  rewrites.sort((left, right) => compareUtf8(
    `${left.destination}\0${left.dependency}`,
    `${right.destination}\0${right.dependency}`,
  ))
  const wantedRewrites = [...expectedRewrites].sort((left, right) => compareUtf8(rewriteKey(left), rewriteKey(right)))
  if (
    rewrites.length !== wantedRewrites.length
    || rewrites.some((rewrite, index) => rewriteKey(rewrite) !== rewriteKey(wantedRewrites[index]))
  ) fail('Mach-O discovered rewrites differ from the locked rewrite inventory.')
  return { files, rewrites }
}

export async function relocateMachOClosure({ payload, architecture, plan, run = defaultRun }) {
  requireAbsolutePath(payload, 'Mach-O payload')
  if (
    (architecture !== 'arm64' && architecture !== 'x86_64')
    || typeof plan !== 'object'
    || plan === null
    || !Array.isArray(plan.files)
    || !Array.isArray(plan.rewrites)
  ) fail('Mach-O relocation request is invalid.')
  const resolvedPayload = await requireCanonicalPayload(payload)
  const destinations = new Set()
  const codeDestinations = new Set()
  const machoDestinations = new Set()
  for (const file of plan.files) {
    if (
      typeof file?.destination !== 'string'
      || !safeEntryPath(file.destination)
      || (file.role !== 'executable' && file.role !== 'code' && file.role !== 'data')
      || (file.executable ? file.role !== 'executable' : file.role === 'executable')
    ) fail('Mach-O closure file is invalid.')
    const folded = file.destination.toLocaleLowerCase('en-US')
    if (destinations.has(folded)) fail('Mach-O closure destination is duplicated.')
    destinations.add(folded)
    if (file.role === 'code') codeDestinations.add(file.destination)
    if (file.role !== 'data') machoDestinations.add(file.destination)
  }
  const rewritePairs = new Set()
  for (const rewrite of plan.rewrites) {
    if (
      typeof rewrite?.destination !== 'string'
      || typeof rewrite?.dependency !== 'string'
      || typeof rewrite?.replacement !== 'string'
      || !safeEntryPath(rewrite.destination)
      || !rewrite.replacement.startsWith('@loader_path/')
    ) fail('Mach-O rewrite is invalid.')
    const replacementDestination = posix.normalize(posix.join(
      posix.dirname(rewrite.destination),
      rewrite.replacement.slice('@loader_path/'.length),
    ))
    if (!safeEntryPath(replacementDestination) || !codeDestinations.has(replacementDestination)) {
      fail('Mach-O rewrite replacement is not an exact code destination.')
    }
    if (!machoDestinations.has(rewrite.destination)) fail('Mach-O rewrite source is not in the exact Mach-O inventory.')
    const pair = `${rewrite.destination}\0${rewrite.dependency}`
    if (rewritePairs.has(pair)) fail('Mach-O rewrite is duplicated.')
    rewritePairs.add(pair)
    const binary = await requirePayloadBinary(resolvedPayload, rewrite.destination, 'Mach-O rewrite binary')
    await successfulRun(
      run,
      '/usr/bin/install_name_tool',
      ['-change', rewrite.dependency, rewrite.replacement, binary],
      'install_name_tool dependency rewrite',
    )
  }
  for (const file of plan.files) {
    if (file.role === 'data') continue
    const binary = await requirePayloadBinary(resolvedPayload, file.destination, 'Mach-O closure binary')
    let ownIdentity
    if (!file.executable) {
      const segments = file.destination.split('/')
      const formula = typeof file.formula === 'string' ? file.formula : segments[0] === 'lib' ? segments[1] : undefined
      if (!formula || segments[0] !== 'lib' || segments[1] !== formula) fail('Mach-O library destination is not namespaced.')
      ownIdentity = `@rpath/autoforge/${formula}/${basename(file.destination)}`
      await successfulRun(
        run,
        '/usr/bin/install_name_tool',
        ['-id', ownIdentity, binary],
        'install_name_tool identity rewrite',
      )
    }
    const inspection = validateInspection(await inspectMachO(binary, { run }), architecture)
    if (inspection.dependencies.some((dependency) => (
      !systemDependency(dependency)
      && !codeDestinations.has(packLocalLoaderDestination(file.destination, dependency))
      && dependency !== ownIdentity
    )) || inspection.rpaths.some((rpath) => rpath.includes('@@HOMEBREW_') || isAbsolute(rpath))) {
      fail('Mach-O dependency remains unresolved after relocation.')
    }
  }
}

export async function adhocSignMachOClosure({ payload, plan, run = defaultRun }) {
  requireAbsolutePath(payload, 'Mach-O payload')
  if (typeof plan !== 'object' || plan === null || !Array.isArray(plan.files)) {
    fail('Mach-O ad-hoc signing request is invalid.')
  }
  const resolvedPayload = await requireCanonicalPayload(payload)
  const files = plan.files.filter((file) => file?.role !== 'data').sort((left, right) => (
    Number(left.executable) - Number(right.executable)
    || compareUtf8(left.destination, right.destination)
  ))
  for (const file of files) {
    if (typeof file?.destination !== 'string' || !safeEntryPath(file.destination)) {
      fail('Mach-O ad-hoc signing file is invalid.')
    }
    const binary = await requirePayloadBinary(resolvedPayload, file.destination, 'Mach-O signing binary')
    await successfulRun(
      run,
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--timestamp=none', binary],
      'Mach-O ad-hoc signing',
    )
  }
}
