import { lstat, readdir, rm } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

interface InitializedApplication {
  recover(): void | Promise<void>
  close?(): void | Promise<void>
}

export interface StartDesktopApplicationOptions<T extends InitializedApplication> {
  whenReady(): Promise<void>
  initialize(): T | Promise<T>
  createWindow(application: T): void | Promise<void>
  showStartupError(message: string): void | Promise<void>
  quit(): void
}

export async function startDesktopApplication<T extends InitializedApplication>(
  options: StartDesktopApplicationOptions<T>,
): Promise<T | undefined> {
  let application: T | undefined
  try {
    await options.whenReady()
    application = await options.initialize()
    await application.recover()
    await options.createWindow(application)
    return application
  } catch {
    try {
      await application?.close?.()
    } catch {
      // Startup remains failed; resource cleanup is best-effort before process exit.
    }
    try {
      await options.showStartupError('AutoForge could not start safely.')
    } catch {
      // Quitting is authoritative even if the native error dialog cannot be shown.
    } finally {
      options.quit()
    }
    return undefined
  }
}

const runtimePrefixes = ['autoforge-execution-', 'autoforge-browser-']

export async function removeInterruptedRuntimeDirectories(temporaryRoot: string): Promise<void> {
  const root = resolve(temporaryRoot)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  await Promise.all(names.filter((name) => runtimePrefixes.some((prefix) => name.startsWith(prefix))).map(async (name) => {
    const path = resolve(root, name)
    if (!path.startsWith(`${root}${sep}`)) return
    try {
      const entry = await lstat(path)
      if (entry.isDirectory() || entry.isSymbolicLink()) await rm(path, { recursive: true, force: true })
    } catch {
      // Startup recovery is best-effort after durable records are terminalized.
    }
  }))
}
