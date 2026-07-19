export interface BrowserCapability {
  open(url: string): Promise<void>
  fill(locator: string, value: string): Promise<void>
  click(locator: string): Promise<void>
  url(): Promise<string>
  close(): Promise<void>
}

export interface WorkflowContext {
  browser: BrowserCapability
}
