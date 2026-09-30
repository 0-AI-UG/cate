// Device state (client settings, recents, known runtimes, window bounds) lives
// on the client device. Portable client code reaches it only through this port;
// each shell implements it (the desktop shell with kernel/state files).
// Documents are named without an extension: `settings`, `ui-state`, `boot`,
// `workspaces`, `known-runtimes`.

export interface DeviceStore {
  /** The named document, or undefined when it does not exist yet. */
  get(name: string): Promise<unknown>
  /** Replace the named document. The shell persists it (debounced, atomic). */
  set(name: string, value: unknown): Promise<void>
  /** Changes to the named document made outside this client (a hand edit,
   *  another window). Own `set` calls are not echoed. */
  subscribe(name: string, onChange: (value: unknown) => void): () => void
}

/** An in-memory DeviceStore, for tests and hosts without persistent storage. */
export function createMemoryDeviceStore(initial: Record<string, unknown> = {}): DeviceStore & {
  /** Simulate an outside change, delivered to subscribers. */
  change(name: string, value: unknown): void
} {
  const docs = new Map<string, unknown>(Object.entries(initial))
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const clone = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  return {
    get: async (name) => clone(docs.get(name)),
    set: async (name, value) => { docs.set(name, clone(value)) },
    subscribe(name, onChange) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, set = new Set())
      set.add(onChange)
      return () => { set.delete(onChange) }
    },
    change(name, value) {
      docs.set(name, clone(value))
      for (const cb of listeners.get(name) ?? []) cb(clone(value))
    },
  }
}
