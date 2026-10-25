// Reports this client's viewed and focused panel, whether it has the
// person's attention (its app has OS focus) and that the person gives input,
// to the runtime's presence. Presence is not persisted, so the report goes
// again after each reconnect.

import type { ClientStateStore } from './clientState'
import type { PresenceClient, PresenceEvent, PresenceReport } from '@workspace/document/contract'

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

/** Input more often than this is reported once. */
export const ACTIVITY_REPORT_MS = 60_000

let lastActivityAt = -Infinity
const activityListeners = new Set<() => void>()

/** The shell tells that the person gave input (a key, a click, a tap). The
 *  runtime keeps the workspace running while a client is in use. */
export function noteClientActivity(now = Date.now()): void {
  if (now - lastActivityAt < ACTIVITY_REPORT_MS) return
  lastActivityAt = now
  for (const listener of [...activityListeners]) listener()
}

export function reportPresence(state: ClientStateStore, link: PresenceLink): () => void {
  let sent: Required<Omit<PresenceReport, 'active'>> | null = null
  let queued = false
  let stopped = false

  const current = (): Required<Omit<PresenceReport, 'active'>> => {
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

  const active = () => { link.report({ active: true }).catch(() => {}) }

  const stopState = state.subscribe(flush)
  attentionListeners.add(flush)
  activityListeners.add(active)
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
    activityListeners.delete(active)
    stopReady()
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** The other clients of a workspace, as its presence stream tells them: one
 *  entry per client (a client with two connections shows once). */
export function watchOtherClients(
  remote: { subscribe(params: undefined, options: { resume: true }): { onEvent(listener: (event: PresenceEvent) => void): () => void; cancel(): void } },
  ownClientId: string,
  onChange: (others: readonly PresenceClient[]) => void,
): () => void {
  const sub = remote.subscribe(undefined, { resume: true })
  sub.onEvent((event) => {
    const byClient = new Map<string, PresenceClient>()
    for (const client of event.clients) {
      if (client.clientId === ownClientId) continue
      const seen = byClient.get(client.clientId)
      if (!seen || client.lastActiveAt > seen.lastActiveAt) byClient.set(client.clientId, client)
    }
    onChange([...byClient.values()])
  })
  return () => sub.cancel()
}
