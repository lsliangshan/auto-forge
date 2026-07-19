import { cp, lstat, mkdir, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-chromium'

const archivePattern = /^chromium-\d+$/

export function findBrowserArchiveRoot(executablePath) {
  const separator = executablePath.includes('\\') && !executablePath.includes('/') ? '\\' : '/'
  const segments = executablePath.split(separator)
  const archiveIndex = segments.findLastIndex((segment) => archivePattern.test(segment))
  if (archiveIndex < 0) {
    throw new Error(`Playwright Chromium archive not found for ${executablePath}`)
  }
  return segments.slice(0, archiveIndex + 1).join(separator)
}

function portableRelativePath(from, to) {
  const value = relative(from, to).split('\\').join('/')
  if (!value || value === '..' || value.startsWith('../') || value.startsWith('/')) {
    throw new Error('The staged Chromium executable must stay under the resources directory')
  }
  return value
}

function isWithin(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function validateStagedSymlinks(
  archiveRoot,
  directory = archiveRoot,
  canonicalArchiveRoot,
) {
  const canonicalRoot = canonicalArchiveRoot ?? await realpath(archiveRoot)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path)
      const lexicalTarget = resolve(dirname(path), target)
      if (isAbsolute(target) || !isWithin(archiveRoot, lexicalTarget)) {
        throw new Error(`Symlink points outside the staged Chromium archive: ${path}`)
      }
      const canonicalTarget = await realpath(path)
      if (!isWithin(canonicalRoot, canonicalTarget)) {
        throw new Error(`Symlink resolves outside the staged Chromium archive: ${path}`)
      }
      continue
    }
    if (metadata.isDirectory()) await validateStagedSymlinks(archiveRoot, path, canonicalRoot)
  }
}

export async function stageBrowser(options = {}) {
  const executablePath = options.executablePath ?? chromium.executablePath()
  const resourcesDirectory = resolve(options.resourcesDirectory
    ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'resources'))
  const sourceArchive = findBrowserArchiveRoot(executablePath)
  const archiveName = basename(sourceArchive.replaceAll('\\', '/'))
  const stagingRoot = join(resourcesDirectory, 'ms-playwright')
  const stagedArchive = join(stagingRoot, archiveName)
  const executableWithinArchive = executablePath
    .slice(sourceArchive.length)
    .replace(/^[\\/]+/, '')
    .split('\\')
    .join('/')

  const sourceMetadata = await stat(executablePath)
  if (!sourceMetadata.isFile() || !executableWithinArchive) {
    throw new Error('The Playwright Chromium executable is missing')
  }

  await mkdir(resourcesDirectory, { recursive: true })
  await rm(stagingRoot, { recursive: true, force: true })
  await mkdir(stagingRoot, { recursive: true })
  await cp(sourceArchive, stagedArchive, { recursive: true, verbatimSymlinks: true })
  await validateStagedSymlinks(stagedArchive)

  const stagedExecutable = join(stagedArchive, ...executableWithinArchive.split('/'))
  if (!(await stat(stagedExecutable)).isFile()) {
    throw new Error('The staged Chromium executable is missing')
  }

  const manifest = {
    version: 1,
    executablePath: portableRelativePath(resourcesDirectory, stagedExecutable),
  }
  await writeFile(
    join(resourcesDirectory, 'browser-runtime.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  return manifest
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  const manifest = await stageBrowser()
  process.stdout.write(`Staged Chromium: ${manifest.executablePath}\n`)
}
