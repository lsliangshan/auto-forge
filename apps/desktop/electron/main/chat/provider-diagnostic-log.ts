import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelProviderId } from '@autoforge/shared'
import type { ProviderDiagnostic, ProviderOperation } from './model-provider.js'

const MAX_LOG_BYTES = 512 * 1024
const LOG_NAME = 'model-provider.jsonl'
const OPERATIONS = new Set<ProviderOperation>(['models', 'chat', 'image', 'video', 'generation'])

function safeMetadata(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 64 && /^[a-z0-9_.-]+$/i.test(value)) {
    return value
  }
  return undefined
}

async function existingBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

export class ProviderDiagnosticLog {
  private tail = Promise.resolve()

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  forProvider(provider: ModelProviderId): (diagnostic: ProviderDiagnostic) => void {
    return (diagnostic) => {
      this.tail = this.tail.then(async () => {
        if (!OPERATIONS.has(diagnostic.operation)) return
        const status = Number.isInteger(diagnostic.status)
          && diagnostic.status! >= 100
          && diagnostic.status! <= 599
          ? diagnostic.status
          : undefined
        const code = safeMetadata(diagnostic.code)
        const errorType = safeMetadata(diagnostic.error_type)
        const line = `${JSON.stringify({
          occurredAt: this.now().toISOString(),
          provider,
          operation: diagnostic.operation,
          ...(status === undefined ? {} : { status }),
          ...(code === undefined ? {} : { code }),
          ...(typeof errorType === 'string' ? { error_type: errorType } : {}),
        })}\n`
        await mkdir(this.directory, { recursive: true })
        const path = join(this.directory, LOG_NAME)
        const replace = await existingBytes(path) + Buffer.byteLength(line) > MAX_LOG_BYTES
        await writeFile(path, line, { encoding: 'utf8', flag: replace ? 'w' : 'a' })
      }).catch(() => undefined)
    }
  }

  async flush(): Promise<void> {
    await this.tail
  }
}
