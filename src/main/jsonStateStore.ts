// Shared in-memory authority for JSON-backed main-process state.
//
// Filesystem-specific concerns stay in a tiny backend: jsonStateFile supplies
// local atomic I/O + chokidar, while extension storage supplies runtime.file.
// Debouncing, serialized writes, echo suppression, external reloads, and
// subscriber delivery live here once.

type JsonStateChangeOrigin = 'local' | 'external'

interface JsonStateBackend<T> {
  read?(): Promise<string | null>
  readSync?(): string | null
  write(value: T, content: string): Promise<void>
  writeSync?(value: T, content: string): void
  watch?(onChange: () => void): (() => void) | Promise<() => void>
}

interface JsonStateStoreOptions<T> {
  defaults: T
  normalize(parsed: unknown, defaults: T): T
  backend: JsonStateBackend<T>
  debounceMs?: number
  onInvalid?(phase: 'load' | 'external'): void
  onError?(operation: 'read' | 'write' | 'watch' | 'writeSync', error: unknown): void
}

export interface JsonStateStore<T> {
  load(): Promise<T>
  loadSync(): T
  get(): T
  set(next: T): void
  update(fn: (current: T) => T): void
  subscribe(cb: (next: T, origin: JsonStateChangeOrigin) => void): () => void
  flush(force?: boolean): Promise<void>
  flushSync(): void
  stopWatching(): void
  dispose(): void
}

const DEFAULT_DEBOUNCE_MS = 150

export function createJsonStateStore<T>(options: JsonStateStoreOptions<T>): JsonStateStore<T> {
  const { defaults, normalize, backend } = options
  const subscribers = new Set<(next: T, origin: JsonStateChangeOrigin) => void>()
  let current = defaults
  let loaded = false
  let loading: Promise<T> | null = null
  let lastWrittenContent = ''
  let revision = 0
  let durableRevision = 0
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  let flushChain: Promise<void> = Promise.resolve()
  let flushInFlight = false
  let queuedWrites = 0
  let writingRevision: number | null = null
  let unwatch: (() => void) | null = null
  let watchArming = false
  let watchGeneration = 0

  const serialize = (value: T): string => JSON.stringify(value, null, 2) + '\n'

  const report = (
    operation: 'read' | 'write' | 'watch' | 'writeSync',
    error: unknown,
  ): void => {
    options.onError?.(operation, error)
  }

  const parse = (raw: string, phase: 'load' | 'external'): T | null => {
    try {
      return normalize(JSON.parse(raw) as unknown, defaults)
    } catch {
      options.onInvalid?.(phase)
      return null
    }
  }

  const initialize = (raw: string | null): T => {
    if (raw != null) {
      const next = parse(raw, 'load')
      if (next != null) {
        current = next
        lastWrittenContent = raw
      }
    }
    loaded = true
    return current
  }

  const load = async (): Promise<T> => {
    if (loaded) return current
    if (loading) return loading
    loading = (async () => {
      let raw: string | null = null
      try {
        raw = backend.read ? await backend.read() : backend.readSync?.() ?? null
      } catch (error) {
        report('read', error)
      }
      return initialize(raw)
    })()
    try {
      return await loading
    } finally {
      loading = null
    }
  }

  const loadSync = (): T => {
    if (loaded) return current
    if (!backend.readSync) {
      throw new Error('This JSON state backend does not support synchronous loading')
    }
    let raw: string | null = null
    try {
      raw = backend.readSync()
    } catch (error) {
      report('read', error)
    }
    return initialize(raw)
  }

  const notify = (origin: JsonStateChangeOrigin): void => {
    for (const cb of subscribers) {
      try { cb(current, origin) } catch { /* isolate subscribers */ }
    }
  }

  const flushWrite = (): Promise<void> => {
    writeTimer = null
    flushInFlight = true
    queuedWrites++
    flushChain = flushChain.then(async () => {
      queuedWrites--
      const value = current
      const content = serialize(value)
      const revisionAtWrite = revision
      writingRevision = revisionAtWrite
      // Record before writing so an eager watcher event still matches.
      lastWrittenContent = content
      try {
        await backend.write(value, content)
        if (revisionAtWrite < durableRevision) {
          // A newer synchronous flush landed while this older async write was
          // in flight. The async backend may have published its stale snapshot
          // after that sync write, so immediately restore the latest authority
          // before allowing the serialized chain to continue.
          const correctionValue = current
          const correctionContent = serialize(correctionValue)
          const correctionRevision = revision
          lastWrittenContent = correctionContent
          try {
            await backend.write(correctionValue, correctionContent)
            durableRevision = Math.max(durableRevision, correctionRevision)
          } catch (error) {
            // The stale write succeeded but its corrective write failed. Mark
            // the state non-durable so a later flush retries it.
            durableRevision = Math.min(durableRevision, revisionAtWrite)
            throw error
          }
        } else {
          durableRevision = Math.max(durableRevision, revisionAtWrite)
        }
      } catch (error) {
        report('write', error)
      } finally {
        writingRevision = null
      }
    })
    const settled = flushChain
    void settled.finally(() => {
      if (flushChain === settled) flushInFlight = false
    })
    return settled
  }

  const scheduleWrite = (): void => {
    if (writeTimer) return
    writeTimer = setTimeout(() => { void flushWrite() }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    writeTimer.unref?.()
  }

  const set = (next: T): void => {
    const changed = serialize(next) !== serialize(current)
    current = next
    revision++
    scheduleWrite()
    if (changed) notify('local')
  }

  const update = (fn: (value: T) => T): void => set(fn(current))

  const reloadExternal = async (): Promise<void> => {
    if (!backend.read) return
    let raw: string | null
    try {
      raw = await backend.read()
    } catch (error) {
      report('read', error)
      return
    }
    if (raw == null || raw === lastWrittenContent) return
    const next = parse(raw, 'external')
    if (next == null) return
    lastWrittenContent = raw
    if (serialize(next) === serialize(current)) return
    current = next
    notify('external')
  }

  const stopWatching = (): void => {
    watchGeneration++
    if (!unwatch) return
    try { unwatch() } catch { /* teardown is best-effort */ }
    unwatch = null
  }

  const ensureWatching = (): void => {
    if (!backend.watch || unwatch || watchArming) return
    watchArming = true
    const generation = ++watchGeneration
    void Promise.resolve(backend.watch(() => { void reloadExternal() }))
      .then((disposeWatch) => {
        if (generation !== watchGeneration || subscribers.size === 0) {
          disposeWatch()
          return
        }
        unwatch = disposeWatch
      })
      .catch((error) => report('watch', error))
      .finally(() => {
        watchArming = false
        // Subscribers may have changed while an async backend was arming.
        if (!unwatch && subscribers.size > 0 && generation !== watchGeneration) ensureWatching()
      })
  }

  const subscribe = (cb: (next: T, origin: JsonStateChangeOrigin) => void): (() => void) => {
    subscribers.add(cb)
    ensureWatching()
    return () => {
      subscribers.delete(cb)
      if (subscribers.size === 0) stopWatching()
    }
  }

  const flush = (force = false): Promise<void> => {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
      return flushWrite()
    }
    if (force) return flushWrite()
    if (revision !== durableRevision) {
      // A queued write snapshots `current` when it starts, so it already covers
      // every revision currently visible. Likewise, an active write for this
      // exact revision is sufficient. Only append when the active snapshot is
      // older than the current state (or a previous write failed and settled).
      if (queuedWrites > 0 || writingRevision === revision) return flushChain
      return flushWrite()
    }
    return flushChain
  }

  const flushSync = (): void => {
    const hadTimer = writeTimer != null
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    if (!backend.writeSync) return
    const content = serialize(current)
    if (!hadTimer && !flushInFlight && revision === durableRevision) return
    try {
      backend.writeSync(current, content)
      lastWrittenContent = content
      durableRevision = revision
    } catch (error) {
      report('writeSync', error)
    }
  }

  const dispose = (): void => {
    flushSync()
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    subscribers.clear()
    stopWatching()
  }

  return {
    load,
    loadSync,
    get: () => current,
    set,
    update,
    subscribe,
    flush,
    flushSync,
    stopWatching,
    dispose,
  }
}
