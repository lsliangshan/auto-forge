import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export const LOCAL_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
export const LOCAL_EMBEDDING_REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900'
export const LOCAL_EMBEDDING_DIMENSIONS = 384
const MAXIMUM_MODEL_FILE_BYTES = 512 * 1024 * 1024

export type LocalModelFetch = (url: string, signal: AbortSignal) => Promise<Response>

export class LocalModelFileCache {
  readonly #root: string

  constructor(
    cacheDirectory: string,
    private readonly fetchRemote: LocalModelFetch,
    private readonly signal: AbortSignal,
  ) {
    this.#root = resolve(cacheDirectory)
  }

  async match(request: string): Promise<Response | undefined> {
    const target = this.#targetFor(request)
    if (!target) return undefined
    try {
      return new Response(await readFile(target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const response = await this.fetchRemote(request, this.signal)
    if (!response.ok) return response
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > MAXIMUM_MODEL_FILE_BYTES) throw new Error('Local embedding model file is too large')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_MODEL_FILE_BYTES) {
      throw new Error('Local embedding model file has an invalid size')
    }
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { flag: 'wx' })
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    return new Response(bytes, { status: response.status, headers: response.headers })
  }

  async put(): Promise<void> {}

  #targetFor(request: string): string | undefined {
    let url: URL
    try {
      url = new URL(request)
    } catch {
      return undefined
    }
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co') return undefined
    const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment))
    const [owner, name, operation, revision, ...filename] = segments
    if (`${owner}/${name}` !== LOCAL_EMBEDDING_MODEL
      || operation !== 'resolve'
      || revision !== LOCAL_EMBEDDING_REVISION
      || filename.length === 0
      || filename.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(sep))) {
      return undefined
    }
    const target = resolve(this.#root, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_REVISION, ...filename)
    const prefix = `${this.#root}${sep}`
    return target.startsWith(prefix) ? target : undefined
  }
}

export interface LocalTextEmbedder {
  readonly model: string
  readonly dimensions: number
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]>
  available(): boolean
  dispose(): Promise<void>
}

interface FeatureTensor {
  readonly data: Float32Array
  readonly dims: readonly number[]
}

interface FeatureExtractor {
  (
    texts: readonly string[],
    options: { pooling: 'mean'; normalize: true },
  ): Promise<FeatureTensor>
  dispose(): Promise<void>
}

export class TransformersLocalTextEmbedder implements LocalTextEmbedder {
  readonly model = LOCAL_EMBEDDING_MODEL
  readonly dimensions = LOCAL_EMBEDDING_DIMENSIONS
  #extractor: Promise<FeatureExtractor> | undefined
  #available = false
  #disposed = false
  #retryAfter = 0

  constructor(
    private readonly cacheDirectory: string,
    private readonly fetchRemote: LocalModelFetch = (url, signal) => globalThis.fetch(url, { signal }),
  ) {}

  available(): boolean {
    return this.#available && !this.#disposed
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly Float32Array[]> {
    if (this.#disposed || signal?.aborted) throw new Error('Local embedding was cancelled')
    if (texts.length < 1 || texts.length > 16
      || texts.some(text => !text || new TextEncoder().encode(text).byteLength > 64 * 1024)) {
      throw new Error('Local embedding input is invalid')
    }
    const extractor = await this.#load(signal)
    if (this.#disposed || signal?.aborted) throw new Error('Local embedding was cancelled')
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    if (this.#disposed || signal?.aborted) throw new Error('Local embedding was cancelled')
    if (output.dims.length !== 2 || output.dims[0] !== texts.length
      || output.dims[1] !== this.dimensions
      || output.data.length !== texts.length * this.dimensions) {
      throw new Error('Local embedding output is invalid')
    }
    const vectors = texts.map((_, index) => {
      const vector = output.data.slice(index * this.dimensions, (index + 1) * this.dimensions)
      if (vector.some(value => !Number.isFinite(value))) {
        throw new Error('Local embedding output is invalid')
      }
      return vector
    })
    this.#available = true
    return vectors
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const extractor = await this.#extractor?.catch(() => undefined)
    await extractor?.dispose()
    this.#available = false
  }

  async #load(signal?: AbortSignal): Promise<FeatureExtractor> {
    if (Date.now() < this.#retryAfter) throw new Error('Local embedding model is cooling down after a load failure')
    this.#extractor ??= (async () => {
      const transformers = await import('@huggingface/transformers')
      transformers.env.cacheDir = this.cacheDirectory
      transformers.env.allowLocalModels = true
      transformers.env.allowRemoteModels = true
      transformers.env.remoteHost = 'https://huggingface.co/'
      transformers.env.useFSCache = false
      transformers.env.useCustomCache = true
      transformers.env.customCache = new LocalModelFileCache(
        this.cacheDirectory,
        this.fetchRemote,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]) : AbortSignal.timeout(5 * 60_000),
      )
      const extractor = await transformers.pipeline(
        'feature-extraction',
        this.model,
        { revision: LOCAL_EMBEDDING_REVISION, dtype: 'q8' },
      )
      return extractor as unknown as FeatureExtractor
    })()
    try {
      const extractor = await this.#extractor
      this.#retryAfter = 0
      return extractor
    } catch (error) {
      this.#extractor = undefined
      this.#available = false
      this.#retryAfter = Date.now() + 5 * 60_000
      throw error
    }
  }
}
