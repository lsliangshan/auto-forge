export interface AutomationContext {
  log(message: string): void
}

export async function run(context: AutomationContext): Promise<void> {
  context.log('AutoForge automation tool is ready.')
}
