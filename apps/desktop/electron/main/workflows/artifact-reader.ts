import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open } from 'node:fs/promises'

export const MAX_WORKFLOW_ARTIFACT_BYTES = 8 * 1024 * 1024

export interface StableRegularFile {
  contents: Buffer
  sha256: string
}

export async function readStableRegularFile(path: string, maxBytes: number): Promise<StableRegularFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid artifact byte limit')
  let handle
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    )
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)) {
      throw new Error('Artifact is not a bounded regular file')
    }

    const contents = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const extra = Buffer.alloc(1)
    const extraRead = await handle.read(extra, 0, 1, contents.length)
    const after = await handle.stat({ bigint: true })
    if (offset !== contents.length
      || extraRead.bytesRead !== 0
      || !after.isFile()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      throw new Error('Artifact changed while being read')
    }
    return {
      contents,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
