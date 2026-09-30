// Reports this client's viewed and focused panel, and whether it has the
// person's attention (its app has OS focus), to the runtime's presence.
// Presence is not persisted, so the report goes again after each reconnect.

import type { ClientStateStore } from './clientState'
import type { PresenceReport } from '@workspace/document/contract'

export interface PresenceLink {
  report(params: PresenceReport): Promise<void>
  onReady(listener: (info: { reconnect: boolean }) => void): () => void
}

let attentive = true
const attentionListeners = new Set<() => void>()

/** The shell reports whether the client has the person's attention; true
 *  until it says otherwise. Runtimes back off background work without it. */
export function setClientAttentive(next: boolean): void {
  if (next === attentive) return
  attentive = next
  for (const listener of [...attentionListeners]) listener()
}

export function reportPresence(state: ClientStateStore, link: PresenceLink): () => void {
  let sent: Required<PresenceReport> | null = null
  let queued = false
  let stopped = false

  const current = (): Required<PresenceReport> => {
    const s = state.getSnapshot()
    return { viewing: [...s.viewing], focused: s.focusedPanelId, attentive }
  }

  // Coalesces bursts (a click changes focus and view) into one report.
  const flush = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (stopped) return
      const next = current()
      if (sent && sent.focused === next.focused && sent.attentive === next.attentive && sameList(sent.viewing, next.viewing)) return
      sent = next
      link.report(next).catch(() => { sent = null })
    })
  }

  const stopState = state.subscribe(flush)
  attentionListeners.add(flush)
  const stopReady = link.onReady(({ reconnect }) => {
    if (!reconnect) return
    sent = null
    flush()
  })
  flush()

  return () => {
    stopped = true
    stopState()
    attentionListeners.delete(flush)
    stopReady()
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
