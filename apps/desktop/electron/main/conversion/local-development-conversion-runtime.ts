import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ConverterPackManager } from './converter-pack-manager.js'
import type { SignedConverterPackIndex } from './converter-pack-types.js'
import {
  createNodeConversionProcessTreePort,
  createConversionProcessRunner,
} from './conversion-process-runner.js'
import {
  createProductionConversionJobRuntime,
  type ProductionConversionRuntimeFactory,
} from './production-conversion-runtime.js'

export interface LocalDevelopmentConverterRelease {
  readonly packsRoot: string
  readonly rootPublicKeyPem: Buffer
  readonly signedIndex: SignedConverterPackIndex
}

async function readStableFile(path: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maximumBytes) {
    throw new Error('Local development converter release contains an invalid file.')
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error('Local development converter release changed while opening.')
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || bytes.byteLength !== opened.size) {
      throw new Error('Local development converter release changed while reading.')
    }
    return bytes
  } finally {
    await handle?.close()
  }
}

export async function loadLocalDevelopmentConverterRelease(
  releaseRoot: string,
): Promise<LocalDevelopmentConverterRelease> {
  if (!isAbsolute(releaseRoot) || await realpath(releaseRoot) !== releaseRoot) {
    throw new Error('Local development converter release root must be canonical and absolute.')
  }
  const root = await lstat(releaseRoot)
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Local development converter release root is invalid.')
  const [indexBytes, signatureBytes, rootPublicKeyPem] = await Promise.all([
    readStableFile(join(releaseRoot, 'index.json'), 1024 * 1024),
    readStableFile(join(releaseRoot, 'index.sig'), 4 * 1024),
    readStableFile(join(releaseRoot, 'root-public-key.pem'), 64 * 1024),
  ])
  let index: unknown
  try {
    index = JSON.parse(indexBytes.toString('utf8'))
  } catch {
    throw new Error('Local development converter index is invalid.')
  }
  const signature = signatureBytes.toString('ascii').trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) throw new Error('Local development converter signature is invalid.')
  const packsRoot = await realpath(join(releaseRoot, 'installed'))
  const packs = await lstat(packsRoot)
  if (packs.isSymbolicLink() || !packs.isDirectory()) throw new Error('Local development converter installation is invalid.')
  return Object.freeze({
    packsRoot,
    rootPublicKeyPem,
    signedIndex: Object.freeze({ index, signature }),
  })
}

export function createLocalDevelopmentConversionRuntimeFactory(options: {
  releaseRoot: string
  platform?: NodeJS.Platform
  arch?: string
}): ProductionConversionRuntimeFactory {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== 'darwin' || (arch !== 'arm64' && arch !== 'x64')) {
    throw new Error('Local development conversion supports darwin-arm64 and darwin-x64 only.')
  }
  const releaseTask = loadLocalDevelopmentConverterRelease(options.releaseRoot)
  const processRunner = createConversionProcessRunner({
    processTree: createNodeConversionProcessTreePort({ platform }),
  })
  return async (context) => {
    const release = await releaseTask
    const packManager = new ConverterPackManager({
      packsRoot: release.packsRoot,
      rootPublicKeyPem: release.rootPublicKeyPem,
      platform,
      arch,
    })
    return {
      packManager,
      runtime: createProductionConversionJobRuntime({
        ownerUserId: context.ownerUserId,
        dataRoot: context.dataRoot,
        database: context.database,
        artifacts: context.artifacts,
        packManager,
        signedIndex: async () => release.signedIndex,
        processRunner,
      }),
    }
  }
}
