export interface ApplicationShutdownCompletionOptions {
  packaged: boolean
  shutdown(): Promise<void>
  quit(): void
  defer?(callback: () => void): void
}

export async function completeApplicationShutdown({
  packaged,
  shutdown,
  quit,
  defer = (callback) => { setImmediate(callback) },
}: ApplicationShutdownCompletionOptions): Promise<void> {
  try {
    await shutdown()
  } catch (error) {
    if (packaged) {
      quit()
      throw error
    }

    await new Promise<void>((resolve) => {
      defer(() => {
        quit()
        resolve()
      })
    })
    throw error
  }

  if (packaged) quit()
  else defer(quit)
}
