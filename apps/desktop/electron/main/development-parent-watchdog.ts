export interface DevelopmentWatchdogTimer {
  unref?(): void
}

export interface DevelopmentParentWatchdogOptions {
  packaged: boolean
  parentPid: number
  quit(): void
  isParentAlive?(pid: number): boolean
  intervalMs?: number
  schedule?(callback: () => void, intervalMs: number): DevelopmentWatchdogTimer
  cancel?(timer: DevelopmentWatchdogTimer): void
}

export function isProcessAlive(
  pid: number,
  sendSignal: (pid: number, signal: 0) => boolean = process.kill,
): boolean {
  try {
    sendSignal(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function startDevelopmentParentWatchdog({
  packaged,
  parentPid,
  quit,
  isParentAlive = isProcessAlive,
  intervalMs = 250,
  schedule = (callback, milliseconds) => setInterval(callback, milliseconds),
  cancel = (timer) => clearInterval(timer as NodeJS.Timeout),
}: DevelopmentParentWatchdogOptions): () => void {
  if (packaged) return () => undefined
  let disposed = false
  let quitRequested = false
  const checkParent = () => {
    if (disposed || quitRequested) return
    try {
      if (isParentAlive(parentPid)) return
    } catch {
      return
    }
    quitRequested = true
    quit()
  }
  const timer = schedule(checkParent, intervalMs)
  timer.unref?.()
  return () => {
    if (disposed) return
    disposed = true
    cancel(timer)
  }
}
