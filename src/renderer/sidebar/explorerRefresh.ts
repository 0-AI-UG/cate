import type { FsWatchEvent } from '../lib/fs/fsWatchManager'

/** Coalesced, bounded, single-flight directory refreshes. Events arriving during
 * a read are retained for a follow-up pass; disposal suppresses stale results. */
export function createExplorerRefresh<T>(options: {
  root: string
  loaded: () => Iterable<string>
  read: (path: string) => Promise<T>
  apply: (path: string, value: T | null, error?: unknown) => void
  remove: (path: string) => void
}) {
  const pending = new Set<string>()
  const inFlight = new Set<string>()
  const removedInFlight = new Set<string>()
  const waiters = new Map<string, Array<() => void>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let disposed = false
  const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')
  const root = normalize(options.root)
  const flush = async () => {
    timer = undefined
    if (running || disposed) return
    running = true
    try {
      while (pending.size && !disposed) {
        const paths = [...pending].slice(0, 4)
        paths.forEach((path) => pending.delete(path))
        await Promise.all(paths.map(async (path) => {
          inFlight.add(path)
          let value: T | null = null
          let readError: unknown
          try { value = await options.read(path) } catch (error) { readError = error }
          inFlight.delete(path)
          const removed = removedInFlight.delete(path)
          if (!disposed && !pending.has(path)) {
            if (!removed) {
              if (readError !== undefined) options.apply(path, value, readError)
              else options.apply(path, value)
            }
            for (const resolve of waiters.get(path) ?? []) resolve()
            waiters.delete(path)
          }
        }))
      }
    } finally { running = false }
  }
  const refresh = (paths: Iterable<string>) => {
    for (const path of paths) pending.add(path)
    if (!disposed && !running && timer === undefined) timer = setTimeout(() => { void flush() }, 150)
  }
  return {
    refresh,
    request(path: string): Promise<void> {
      if (disposed) return Promise.resolve()
      const result = new Promise<void>((resolve) => {
        const existing = waiters.get(path) ?? []
        existing.push(resolve)
        waiters.set(path, existing)
      })
      pending.add(path)
      clearTimeout(timer)
      void flush()
      return result
    },
    event(event: FsWatchEvent) {
      const path = normalize(event.path)
      if (path !== root && !path.startsWith(root + '/')) return
      const loaded = new Map([...options.loaded()].map((dir) => [normalize(dir), dir]))
      loaded.set(root, options.root)
      if (event.type === 'delete') {
        options.remove(event.path)
        for (const directory of inFlight) {
          const normalized = normalize(directory)
          if (normalized === path || normalized.startsWith(path + '/')) removedInFlight.add(directory)
        }
      }
      // File-content updates do not change directory membership. Directory
      // updates from watchers still invalidate that directory when loaded.
      const target = event.type === 'update' ? path : path.substring(0, path.lastIndexOf('/'))
      const directory = loaded.get(target)
      if (directory) refresh([directory])
    },
    dispose() {
      disposed = true; pending.clear(); clearTimeout(timer)
      for (const callbacks of waiters.values()) for (const resolve of callbacks) resolve()
      waiters.clear()
    },
  }
}
