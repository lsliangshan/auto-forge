export interface BrowserCapability {
  open(url: string): Promise<void>
  fill(locator: string, value: string): Promise<void>
  click(locator: string): Promise<void>
  url(): Promise<string>
  close(): Promise<void>
}

export interface LoggerCapability {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface WorkflowContext {
  browser: BrowserCapability
  logger: LoggerCapability
}
