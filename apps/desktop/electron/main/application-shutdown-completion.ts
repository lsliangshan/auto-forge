export interface ApplicationShutdownCompletionOptions {
  packaged: boolean
  shutdown(): Promise<void>
  quit(): void
  defer?(callback: () => void): void
}

export interface DesktopApplicationResourceCloseOptions {
  stopConversionJobs?(): Promise<void>
  closeApplication?(): Promise<void>
  closeUserDataStores?(): void
  resetUserDataStores(): void
}

export async function closeDesktopApplicationResources({
  stopConversionJobs,
  closeApplication,
  closeUserDataStores,
  resetUserDataStores,
}: DesktopApplicationResourceCloseOptions): Promise<void> {
  let conversionFailure: unknown
  let conversionRejected = false
  let applicationFailure: unknown
  let applicationRejected = false
  let userStoreFailure: unknown
  let userStoreCloseRejected = false
  try {
    await stopConversionJobs?.()
  } catch (error) {
    conversionFailure = error
    conversionRejected = true
  }
  try {
    await closeApplication?.()
  } catch (error) {
    applicationFailure = error
    applicationRejected = true
  } finally {
    resetUserDataStores()
    try {
      closeUserDataStores?.()
    } catch (error) {
      userStoreFailure = error
      userStoreCloseRejected = true
    }
  }
  if (conversionRejected) throw conversionFailure
  if (applicationRejected) throw applicationFailure
  if (userStoreCloseRejected) throw userStoreFailure
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
