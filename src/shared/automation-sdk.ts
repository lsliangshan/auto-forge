export type LoadState = 'loading' | 'domcontentloaded' | 'networkidle'

export type WaitForSelectorOptions = {
  timeout?: number
  state?: 'attached' | 'visible' | 'hidden' | 'detached'
}

export type PageApi = {
  goto(url: string): Promise<void>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  press(selector: string, key: string): Promise<void>
  waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<void>
  waitForUrl(pattern: string): Promise<void>
  textContent(selector: string): Promise<string | null>
  exists(selector: string): Promise<boolean>
  evaluate<T>(fn: string, args?: unknown[]): Promise<T>
}

export type ToolLogger = {
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

export type ToolProgress = {
  set(value: number): void
  message(text: string): void
}

export type SecretStore = {
  get(name: string): Promise<string>
}

export type ToolContext = {
  page: PageApi
  input: Record<string, unknown>
  secrets: SecretStore
  log: ToolLogger
  progress: ToolProgress
  signal: AbortSignal
}

export type ToolDefinition = {
  name?: string
  version?: string
  run(ctx: ToolContext): Promise<void>
}

export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition
}
