import { spawnSync } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import { compareUtf8, fail, isPathInsideRoot, requireAbsolutePath, safeEntryPath } from './pack-tooling-lib.mjs'

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
  return systemPrefixes.some((prefix) => path.startsWith(prefix))
}

async function existingRegular(path) {
  const resolved = await realpath(path).catch(() => undefined)
  if (resolved === undefined) return undefined
  const metadata = await lstat(resolved).catch(() => undefined)
  return metadata?.isFile() && !metadata.isSymbolicLink() ? resolved : undefined
}

function expandAnchor(value, sourceDirectory, executableDirectory) {
  if (value === '@loader_path') return sourceDirectory
  if (value.startsWith('@loader_path/')) return join(sourceDirectory, value.slice('@loader_path/'.length))
  if (value === '@executable_path') return executableDirectory
  if (value.startsWith('@executable_path/')) return join(executableDirectory, value.slice('@executable_path/'.length))
  if (isAbsolute(value)) return value
  return undefined
}

async function resolveDependency(dependency, inspection, node) {
  if (systemDependency(dependency)) return undefined
  const sourceDirectory = dirname(node.source)
  if (dependency.startsWith('@rpath/')) {
    const suffix = dependency.slice('@rpath/'.length)
    for (const rpath of inspection.rpaths) {
      const base = expandAnchor(rpath, sourceDirectory, node.executableDirectory)
      if (base === undefined) continue
      const candidate = await existingRegular(join(base, suffix))
      if (candidate !== undefined) return candidate
    }
    fail(`Mach-O dependency is unresolved: ${dependency}`)
  }
  const expanded = expandAnchor(dependency, sourceDirectory, node.executableDirectory)
  if (expanded === undefined) fail(`Mach-O dependency is unresolved: ${dependency}`)
  const candidate = await existingRegular(expanded)
  if (candidate === undefined) fail(`Mach-O dependency is unresolved: ${dependency}`)
  return candidate
}

function validateInspection(value, source, architecture) {
  if (
    typeof value !== 'object'
    || value === null
    || !Array.isArray(value.architectures)
    || !Array.isArray(value.dependencies)
    || !Array.isArray(value.rpaths)
    || value.architectures.some((item) => typeof item !== 'string')
    || value.dependencies.some((item) => typeof item !== 'string' || item.length === 0)
    || value.rpaths.some((item) => typeof item !== 'string' || item.length === 0)
  ) fail(`Mach-O inspection is invalid: ${source}`)
  if (!value.architectures.includes(architecture)) fail(`Mach-O architecture mismatch: ${source}`)
  return value
}

function replacementFor(fromDestination, dependencyDestination) {
  const relative = posix.relative(posix.dirname(fromDestination), dependencyDestination)
  return `@loader_path/${relative}`
}

export async function planMachOClosure({ entrypoints, architecture, inspect }) {
  if (
    !Array.isArray(entrypoints)
    || entrypoints.length === 0
    || (architecture !== 'arm64' && architecture !== 'x86_64')
    || typeof inspect !== 'function'
  ) fail('Mach-O closure request is invalid.')

  const files = []
  const rewrites = []
  const bySource = new Map()
  const byDestination = new Map()
  const queue = []

  const add = async (source, destination, executable, executableDirectory) => {
    if (!safeEntryPath(destination)) fail('Mach-O destination is unsafe.')
    const resolved = await existingRegular(source)
    if (resolved === undefined) fail(`Mach-O source is not a regular file: ${source}`)
    const existingDestination = byDestination.get(destination.toLowerCase())
    if (existingDestination !== undefined && existingDestination !== resolved) {
      fail(`Mach-O destination collision: ${destination}`)
    }
    const existing = bySource.get(resolved)
    if (existing !== undefined) return existing
    const node = { source: resolved, destination, executable, executableDirectory }
    bySource.set(resolved, node)
    byDestination.set(destination.toLowerCase(), resolved)
    files.push({ source: resolved, destination, executable })
    queue.push(node)
    return node
  }

  for (const entrypoint of entrypoints) {
    if (typeof entrypoint !== 'object' || entrypoint === null) fail('Mach-O entrypoint is invalid.')
    const source = await existingRegular(entrypoint.source)
    if (source === undefined) fail('Mach-O entrypoint is invalid.')
    await add(source, entrypoint.destination, true, dirname(source))
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor]
    const inspection = validateInspection(await inspect(node.source), node.source, architecture)
    for (const dependency of inspection.dependencies) {
      const resolved = await resolveDependency(dependency, inspection, node)
      if (resolved === undefined) continue
      if (resolved === node.source) continue
      const dependencyNode = await add(resolved, `lib/${basename(resolved)}`, false, node.executableDirectory)
      rewrites.push({
        destination: node.destination,
        dependency,
        replacement: replacementFor(node.destination, dependencyNode.destination),
      })
    }
  }

  files.sort((left, right) => {
    if (left.executable !== right.executable) return left.executable ? -1 : 1
    return compareUtf8(left.destination, right.destination)
  })
  rewrites.sort((left, right) => compareUtf8(
    `${left.destination}\0${left.dependency}`,
    `${right.destination}\0${right.dependency}`,
  ))
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
  const resolvedPayload = await realpath(payload)
  for (const rewrite of plan.rewrites) {
    if (
      typeof rewrite?.destination !== 'string'
      || typeof rewrite?.dependency !== 'string'
      || typeof rewrite?.replacement !== 'string'
      || !safeEntryPath(rewrite.destination)
      || !rewrite.replacement.startsWith('@loader_path/')
    ) fail('Mach-O rewrite is invalid.')
    const binary = join(resolvedPayload, ...rewrite.destination.split('/'))
    if (!isPathInsideRoot(resolvedPayload, binary)) fail('Mach-O rewrite destination is unsafe.')
    await successfulRun(
      run,
      '/usr/bin/install_name_tool',
      ['-change', rewrite.dependency, rewrite.replacement, binary],
      'install_name_tool dependency rewrite',
    )
  }
  for (const file of plan.files) {
    if (typeof file?.destination !== 'string' || !safeEntryPath(file.destination)) fail('Mach-O closure file is invalid.')
    const binary = join(resolvedPayload, ...file.destination.split('/'))
    if (!file.executable) {
      await successfulRun(
        run,
        '/usr/bin/install_name_tool',
        ['-id', `@rpath/${basename(file.destination)}`, binary],
        'install_name_tool identity rewrite',
      )
    }
    const inspection = validateInspection(await inspectMachO(binary, { run }), binary, architecture)
    const ownIdentity = file.executable ? undefined : `@rpath/${basename(file.destination)}`
    if (inspection.dependencies.some((dependency) => (
      !systemDependency(dependency)
      && !dependency.startsWith('@loader_path/')
      && dependency !== ownIdentity
    ))) fail(`Mach-O dependency remains unresolved after relocation: ${binary}`)
  }
}

export async function adhocSignMachOClosure({ payload, plan, run = defaultRun }) {
  requireAbsolutePath(payload, 'Mach-O payload')
  if (typeof plan !== 'object' || plan === null || !Array.isArray(plan.files)) {
    fail('Mach-O ad-hoc signing request is invalid.')
  }
  const resolvedPayload = await realpath(payload)
  const files = [...plan.files].sort((left, right) => (
    Number(left.executable) - Number(right.executable)
    || compareUtf8(left.destination, right.destination)
  ))
  for (const file of files) {
    if (typeof file?.destination !== 'string' || !safeEntryPath(file.destination)) {
      fail('Mach-O ad-hoc signing file is invalid.')
    }
    const binary = join(resolvedPayload, ...file.destination.split('/'))
    if (!isPathInsideRoot(resolvedPayload, binary)) fail('Mach-O ad-hoc signing path is unsafe.')
    await successfulRun(
      run,
      '/usr/bin/codesign',
      ['--force', '--sign', '-', '--timestamp=none', binary],
      'Mach-O ad-hoc signing',
    )
  }
}
