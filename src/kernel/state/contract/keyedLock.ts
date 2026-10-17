/** A keyed async mutex: `run(key, fn)` queues `fn` after any prior work for the
 *  same key. Different keys run independently. */
export class KeyedLock {
  private locks = new Map<string, Promise<unknown>>()

  /** A rejecting `fn` does not wedge the chain: the next queued fn still runs,
   *  and the stored tail swallows rejections. The returned promise rejects with
   *  `fn`'s own error. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.locks.set(key, tail)
    void tail.finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
    return next
  }
}
