import { randomUUID } from 'node:crypto'

/** Every live owner must acknowledge this attempt after durable publication. */
export function flushDockWindowsBeforeQuit(opts: {
  windowIds: number[]
  requestSync: (windowId: number, requestId: string) => void
  subscribeAck: (handler: (windowId: number, error?: string, requestId?: string) => void) => () => void
  timeoutMs: number
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}): Promise<Set<number>> {
  if (!opts.windowIds.length) return Promise.resolve(new Set())
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const pending = new Set(opts.windowIds)
    const acked = new Set<number>()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) (opts.clearTimeoutFn ?? clearTimeout)(timer)
      unsubscribe()
      if (error) reject(error)
      else resolve(acked)
    }
    unsubscribe = opts.subscribeAck((id, error, responseId) => {
      if (responseId !== requestId || !pending.has(id) || settled) return
      if (error) { finish(new Error(`Dock window ${id} sync failed: ${error}`)); return }
      pending.delete(id)
      acked.add(id)
      if (!pending.size) finish()
    })
    const armTimer = opts.setTimeoutFn ?? ((fn: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(fn, ms))
    timer = armTimer(() => finish(new Error(`Dock window sync timed out: ${[...pending].join(', ')}`)), opts.timeoutMs)
    for (const id of pending) {
      if (settled) break
      try { opts.requestSync(id, requestId) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    }
  })
}
