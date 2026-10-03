// "Is work running?" Modules contribute a predicate (busy terminals, running
// agents, T3 turns); lifetime and power ask the combined answer.

export interface BusyRegistry {
  /** Adds a source; returns its removal. */
  contribute(source: () => boolean): () => void
  busy(): boolean
}

export function createBusyRegistry(): BusyRegistry {
  const sources = new Set<() => boolean>()
  return {
    contribute(source) {
      sources.add(source)
      return () => { sources.delete(source) }
    },
    busy() {
      for (const source of sources) {
        try { if (source()) return true } catch { /* a broken source counts as idle */ }
      }
      return false
    },
  }
}
