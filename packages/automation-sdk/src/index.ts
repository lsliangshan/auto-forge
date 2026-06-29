export const toolPermissions = [
  'page:navigate',
  'dom:read',
  'dom:write',
  'network:read',
  'network:request',
  'storage:tool',
  'files:download',
  'files:upload',
  'secrets:read'
] as const

export type ToolPermission = (typeof toolPermissions)[number]

export const inputTypes = ['string', 'number', 'boolean', 'secret', 'select'] as const

export type InputType = 'string' | 'number' | 'boolean' | 'secret' | 'select'

export type InputDefinition = {
  type: InputType
  required?: boolean
  label?: string
  description?: string
  options?: string[]
  defaultValue?: string | number | boolean
}

export type ToolInputsDefinition = Record<string, InputDefinition>

export type ToolManifest<TInputs extends ToolInputsDefinition = ToolInputsDefinition> = {
  name: string
  displayName?: string
  version: string
  description?: string
  entry: string
  matches: string[]
  permissions: ToolPermission[]
  inputs?: TInputs
}

export type PluginValidationResult = {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export type LoadState = 'loading' | 'domcontentloaded' | 'networkidle'

export type TimeoutOptions = {
  timeout?: number
}

export type GotoOptions = TimeoutOptions & {
  waitUntil?: LoadState
}

export type ClickOptions = TimeoutOptions & {
  button?: 'left' | 'middle' | 'right'
  clickCount?: number
}

export type TypeOptions = TimeoutOptions & {
  delay?: number
}

export type WaitForSelectorOptions = TimeoutOptions & {
  state?: 'attached' | 'visible' | 'hidden' | 'detached'
}

export type WaitForTextOptions = TimeoutOptions & {
  exact?: boolean
}

export type WaitForFunctionOptions = TimeoutOptions

export type EvaluateOptions = TimeoutOptions & {
  permissions?: ToolPermission[]
}

export type ElementRef = {
  selector: string
}

export type ExtractField =
  | string
  | {
      selector: string
      attr?: string
      many?: false
    }
  | {
      selector: string
      many: true
      fields: ExtractSchema
    }

export type ExtractSchema = Record<string, ExtractField>

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type NetworkRequest = {
  url: string
  method?: HttpMethod
  headers?: Record<string, string>
  body?: unknown
  timeout?: number
}

export type ResponseInfo<TBody = unknown> = {
  url: string
  status: number
  headers: Record<string, string>
  body: TBody
}

export type DownloadedFile = {
  filename: string
  size: number
  mimeType?: string
}

export type ToolFile = {
  name: string
  mimeType?: string
  content: ArrayBuffer | Uint8Array | string
}

export type PageApi = {
  goto(url: string, options?: GotoOptions): Promise<void>
  reload(options?: TimeoutOptions): Promise<void>
  back(options?: TimeoutOptions): Promise<void>
  forward(options?: TimeoutOptions): Promise<void>
  url(): Promise<string>
  title(): Promise<string>
  waitForLoadState(state?: LoadState, options?: TimeoutOptions): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  click(selector: string, options?: ClickOptions): Promise<void>
  dblclick(selector: string, options?: ClickOptions): Promise<void>
  hover(selector: string, options?: TimeoutOptions): Promise<void>
  fill(selector: string, value: string, options?: TimeoutOptions): Promise<void>
  type(selector: string, value: string, options?: TypeOptions): Promise<void>
  press(selector: string, key: string, options?: TimeoutOptions): Promise<void>
  select(selector: string, value: string | string[], options?: TimeoutOptions): Promise<void>
  check(selector: string, options?: TimeoutOptions): Promise<void>
  uncheck(selector: string, options?: TimeoutOptions): Promise<void>
  focus(selector: string, options?: TimeoutOptions): Promise<void>
  scrollIntoView(selector: string, options?: TimeoutOptions): Promise<void>
  waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<ElementRef>
  waitForText(text: string, options?: WaitForTextOptions): Promise<void>
  waitForUrl(pattern: string | RegExp, options?: TimeoutOptions): Promise<void>
  waitForFunction<T>(fn: string, args?: unknown[], options?: WaitForFunctionOptions): Promise<T>
  textContent(selector: string, options?: TimeoutOptions): Promise<string | null>
  innerText(selector: string, options?: TimeoutOptions): Promise<string | null>
  innerHTML(selector: string, options?: TimeoutOptions): Promise<string | null>
  getAttribute(selector: string, name: string, options?: TimeoutOptions): Promise<string | null>
  exists(selector: string, options?: TimeoutOptions): Promise<boolean>
  count(selector: string, options?: TimeoutOptions): Promise<number>
  extract<T>(schema: ExtractSchema): Promise<T>
  evaluate<T>(fn: string, args?: unknown[], options?: EvaluateOptions): Promise<T>
}

export type NetworkApi = {
  waitForResponse<TBody = unknown>(
    pattern: string | RegExp,
    options?: TimeoutOptions
  ): Promise<ResponseInfo<TBody>>
  request<TBody = unknown>(options: NetworkRequest): Promise<ResponseInfo<TBody>>
}

export type FilesApi = {
  download(options?: { filename?: string; timeout?: number }): Promise<DownloadedFile>
  upload(selector: string, file: ToolFile, options?: TimeoutOptions): Promise<void>
  saveText(filename: string, content: string): Promise<void>
  saveJson(filename: string, data: unknown): Promise<void>
}

export type SecretStore<TSecretName extends string = string> = {
  get(name: TSecretName): Promise<string>
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

export type ToolInput = Record<string, unknown>

export type ToolContext<
  TInput extends ToolInput = ToolInput,
  TSecretName extends string = string
> = {
  page: PageApi
  network: NetworkApi
  files: FilesApi
  input: TInput
  secrets: SecretStore<TSecretName>
  log: ToolLogger
  progress: ToolProgress
  signal: AbortSignal
}

export type ToolDefinition<
  TInput extends ToolInput = ToolInput,
  TSecretName extends string = string
> = {
  name?: string
  version?: string
  run(ctx: ToolContext<TInput, TSecretName>): Promise<void>
}

export function defineTool<
  TInput extends ToolInput = ToolInput,
  TSecretName extends string = string
>(definition: ToolDefinition<TInput, TSecretName>): ToolDefinition<TInput, TSecretName> {
  return definition
}

export function defineManifest<TInputs extends ToolInputsDefinition = ToolInputsDefinition>(
  manifest: ToolManifest<TInputs>
): ToolManifest<TInputs> {
  return manifest
}

export function isToolPermission(value: string): value is ToolPermission {
  return toolPermissions.includes(value as ToolPermission)
}

export function isInputType(value: string): value is InputType {
  return inputTypes.includes(value as InputType)
}

export function validateManifest(value: unknown): PluginValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isRecord(value)) {
    return { ok: false, errors: ['Manifest must be an object.'], warnings }
  }

  requireString(value, 'name', errors)
  requireString(value, 'version', errors)
  requireString(value, 'entry', errors)
  requireStringArray(value, 'matches', errors)

  const permissions = value.permissions
  if (!Array.isArray(permissions) || permissions.length === 0) {
    errors.push('permissions must be a non-empty string array.')
  } else {
    for (const permission of permissions) {
      if (typeof permission !== 'string' || !isToolPermission(permission)) {
        errors.push(`Unsupported permission: ${String(permission)}`)
      }
    }
  }

  if (Array.isArray(value.matches) && value.matches.some((match) => match === '<all_urls>')) {
    warnings.push('Avoid <all_urls> in the first plugin version. Prefer explicit host matches.')
  }

  if ('inputs' in value && value.inputs !== undefined) {
    if (!isRecord(value.inputs)) {
      errors.push('inputs must be an object when provided.')
    } else {
      validateInputs(value.inputs, errors)
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function validateInputs(inputs: Record<string, unknown>, errors: string[]): void {
  for (const [name, definition] of Object.entries(inputs)) {
    if (name.trim() === '') {
      errors.push('input name must be a non-empty string.')
      continue
    }

    if (!isRecord(definition)) {
      errors.push(`input "${name}" must be an object.`)
      continue
    }

    if (typeof definition.type !== 'string' || !isInputType(definition.type)) {
      errors.push(`input "${name}" has unsupported type: ${String(definition.type)}`)
    }

    if (
      definition.required !== undefined &&
      typeof definition.required !== 'boolean'
    ) {
      errors.push(`input "${name}".required must be a boolean when provided.`)
    }

    if (
      definition.type === 'select' &&
      (!Array.isArray(definition.options) || definition.options.length === 0)
    ) {
      errors.push(`input "${name}" with type "select" must provide non-empty options.`)
    }
  }
}

export function assertManifest(value: unknown): asserts value is ToolManifest {
  const result = validateManifest(value)
  if (!result.ok) {
    throw new Error(result.errors.join('\n'))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof value[key] !== 'string' || value[key].trim() === '') {
    errors.push(`${key} must be a non-empty string.`)
  }
}

function requireStringArray(value: Record<string, unknown>, key: string, errors: string[]): void {
  if (!Array.isArray(value[key]) || value[key].length === 0) {
    errors.push(`${key} must be a non-empty string array.`)
    return
  }

  for (const item of value[key]) {
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`${key} can only contain non-empty strings.`)
    }
  }
}
