import { toSafeAppError } from '@autoforge/shared'

/** Serializes auth identity transitions against complete Main-owned knowledge operations. */
export class KnowledgeAdmissionGate {
  private epoch = 0
  private tail = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const enteredEpoch = this.epoch
    return this.enqueue(async () => {
      if (enteredEpoch !== this.epoch) throw toSafeAppError({ code: 'CONFLICT' })
      const result = await operation()
      if (enteredEpoch !== this.epoch) throw toSafeAppError({ code: 'CONFLICT' })
      return result
    })
  }

  transition<T>(operation: () => Promise<T>): Promise<T> {
    this.epoch += 1
    return this.enqueue(operation)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
