// Presence (9.1): the connected clients, the panels each shows and focuses
// (clients report them), and which client acted last. Never persisted.
// The kernel/api router asks it for the active panel; the panel framework
// asks it for the driving client of a panel (10.2).

import type { ClientConnection, LifecycleBus } from '@kernel/lifecycle/contract'
import type { PanelId, PresenceClient, PresenceEvent, PresenceReport } from '../contract'

export interface PresenceService {
  clients(): PresenceClient[]
  client(connectionId: number): PresenceClient | undefined
  report(connectionId: number, report: PresenceReport): void
  /** The client did something (sent an op, called a method). */
  touch(connectionId: number): void
  /** The client showed or used a panel: it becomes the panel's most recent
   *  user and counts as activity. */
  usedPanel(connectionId: number, panelId: PanelId): void
  /** The most recently active client. */
  activeClient(): PresenceClient | null
  /** The focused panel of the most recently active client. */
  activePanelId(): PanelId | undefined
  /** Among the clients `eligible` accepts: the one that most recently showed
   *  or used `panelId`, else the most recently active one. */
  pick(eligible: (client: PresenceClient) => boolean, panelId?: PanelId): PresenceClient | null
  subscribe(listener: (event: PresenceEvent) => void): () => void
  dispose(): void
}

interface Entry {
  info: PresenceClient
  /** Orders activity; wall clock time can tie. */
  activeTick: number
  panelTicks: Map<PanelId, number>
}

export function createPresence(deps: { lifecycle: LifecycleBus; now?: () => number }): PresenceService {
  const now = deps.now ?? Date.now
  const entries = new Map<number, Entry>()
  const listeners = new Set<(event: PresenceEvent) => void>()
  let tick = 0

  const ordered = () => [...entries.values()].sort((a, b) => b.activeTick - a.activeTick)
  const event = (): PresenceEvent => {
    const all = ordered()
    return { clients: all.map((e) => e.info), activeClientId: all[0]?.info.clientId ?? null }
  }
  const changed = () => {
    if (listeners.size === 0) return
    const next = event()
    for (const listener of [...listeners]) listener(next)
  }
  const activate = (entry: Entry) => {
    entry.activeTick = ++tick
    entry.info = { ...entry.info, lastActiveAt: now() }
  }

  const connected = (client: ClientConnection) => {
    const entry: Entry = {
      info: {
        connectionId: client.connectionId,
        clientId: client.clientId,
        device: { ...client.device },
        features: [...client.features],
        viewing: [],
        focused: null,
        attentive: true,
        lastActiveAt: now(),
      },
      activeTick: ++tick,
      panelTicks: new Map(),
    }
    entries.set(client.connectionId, entry)
    changed()
  }
  const gone = (client: ClientConnection) => {
    if (entries.delete(client.connectionId)) changed()
  }
  const offConnected = deps.lifecycle.onClientConnected(connected)
  const offGone = deps.lifecycle.onClientGone(gone)

  return {
    clients: () => ordered().map((e) => e.info),
    client: (connectionId) => entries.get(connectionId)?.info,
    report(connectionId, report) {
      const entry = entries.get(connectionId)
      if (!entry) return
      const viewing = Array.isArray(report.viewing)
        ? [...new Set(report.viewing.filter((id): id is string => typeof id === 'string'))]
        : entry.info.viewing
      const focused = report.focused === undefined
        ? entry.info.focused
        : typeof report.focused === 'string' ? report.focused : null
      const attentive = typeof report.attentive === 'boolean' ? report.attentive : entry.info.attentive
      if (report.viewing !== undefined || report.focused !== undefined) activate(entry)
      for (const panelId of viewing) if (!entry.info.viewing.includes(panelId)) entry.panelTicks.set(panelId, tick)
      if (focused && focused !== entry.info.focused) entry.panelTicks.set(focused, tick)
      entry.info = { ...entry.info, viewing, focused, attentive }
      changed()
    },
    touch(connectionId) {
      const entry = entries.get(connectionId)
      if (!entry) return
      activate(entry)
      changed()
    },
    usedPanel(connectionId, panelId) {
      const entry = entries.get(connectionId)
      if (!entry) return
      activate(entry)
      entry.panelTicks.set(panelId, tick)
      changed()
    },
    activeClient: () => ordered()[0]?.info ?? null,
    activePanelId: () => ordered()[0]?.info.focused ?? undefined,
    pick(eligible, panelId) {
      const candidates = ordered().filter((e) => eligible(e.info))
      if (panelId !== undefined) {
        let best: Entry | null = null
        for (const entry of candidates) {
          const at = entry.panelTicks.get(panelId)
          if (at !== undefined && (!best || at > best.panelTicks.get(panelId)!)) best = entry
        }
        if (best) return best.info
      }
      return candidates[0]?.info ?? null
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      offConnected()
      offGone()
      listeners.clear()
      entries.clear()
    },
  }
}
