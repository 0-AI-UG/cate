// "Is work running?" Modules contribute a predicate per kind of work (agents
// in a turn, commands in terminals); lifetime, power and stopping ask it.

export type WorkKind = 'agents' | 'commands'

export interface BusyRegistry {
  /** Adds a source; returns its removal. */
  contribute(kind: WorkKind, source: () => boolean): () => void
  /** Any work of `kinds` (default: every kind) runs. */
  busy(kinds?: readonly WorkKind[]): boolean
}

export function createBusyRegistry(): BusyRegistry {
  const sources = new Set<{ kind: WorkKind; source: () => boolean }>()
  return {
    contribute(kind, source) {
      const entry = { kind, source }
      sources.add(entry)
      return () => { sources.delete(entry) }
    },
    busy(kinds) {
      for (const { kind, source } of sources) {
        if (kinds && !kinds.includes(kind)) continue
        try { if (source()) return true } catch { /* a broken source counts as idle */ }
      }
      return false
    },
  }
}
