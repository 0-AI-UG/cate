// =============================================================================
// KeyedLock — serialize async work per string key. Extracted from the identical
// per-key lock that ExtensionServerManager, WorkspaceCateApiManager, and
// CodingManager each carried, so lifecycle transitions for one key never
// interleave (e.g. two concurrent spawns both minting a listener).
// =============================================================================

/** A keyed async mutex: `run(key, fn)` queues `fn` after any prior work for the
 *  same key. Different keys run independently. */
export class KeyedLock {
  private locks = new Map<string, Promise<unknown>>()

  /** Run `fn` after the previous work queued under `key` settles, serializing
   *  per key. A rejecting `fn` does NOT wedge the chain: the next queued fn still
   *  runs (`prev.then(fn, fn)`), and the stored tail swallows rejections so a
   *  failure never poisons later callers. The returned promise rejects with
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
