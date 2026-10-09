// Terminal activity of each open workspace, as the sidebar shows it: the
// runtime's `process.statuses` channel, mirrored while someone looks. Agent
// states come from services/agents/ui.

import { useSyncExternalStore } from 'react'
import { mirrorChannel, subscribeRuntimes, tryRuntimeFor, type ChannelMirror } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { applyStatusChange, type TerminalStatuses, type TerminalStatusChange } from '@services/terminal/contract'

const EMPTY: TerminalStatuses = {}

interface Entry {
  runtime: RuntimeProxy
  mirror: ChannelMirror<TerminalStatuses>
  snapshot: TerminalStatuses
  listeners: Set<() => void>
}

const entries = new Map<string, Entry>()

function dispose(workspaceId: string): void {
  const entry = entries.get(workspaceId)
  if (!entry) return
  entries.delete(workspaceId)
  entry.mirror.dispose()
  for (const l of [...entry.listeners]) l()
}

subscribeRuntimes(() => {
  for (const [workspaceId, entry] of [...entries]) {
    if (tryRuntimeFor(workspaceId) !== entry.runtime) dispose(workspaceId)
  }
})

function entryFor(workspaceId: string): Entry | null {
  const runtime = tryRuntimeFor(workspaceId)
  if (!runtime) return null
  const existing = entries.get(workspaceId)
  if (existing?.runtime === runtime) return existing
  if (existing) dispose(workspaceId)
  const mirror = mirrorChannel<TerminalStatuses, TerminalStatusChange>(() => runtime.process.statuses(), applyStatusChange)
  const entry: Entry = { runtime, mirror, snapshot: EMPTY, listeners: new Set() }
  mirror.subscribe((state) => {
    entry.snapshot = state?.snapshot ?? EMPTY
    for (const l of [...entry.listeners]) l()
  })
  entries.set(workspaceId, entry)
  return entry
}

/** The latest terminal statuses of a workspace, by terminal id; empty while
 *  it is not open. */
export function terminalStatuses(workspaceId: string): TerminalStatuses {
  return entryFor(workspaceId)?.snapshot ?? EMPTY
}

function subscribe(workspaceId: string, listener: () => void): () => void {
  const offRuntimes = subscribeRuntimes(listener)
  const entry = entryFor(workspaceId)
  entry?.listeners.add(listener)
  return () => {
    entry?.listeners.delete(listener)
    offRuntimes()
  }
}

const noop = () => () => {}

export function useTerminalStatuses(workspaceId: string | null | undefined): TerminalStatuses {
  return useSyncExternalStore(
    workspaceId ? (l) => subscribe(workspaceId, l) : noop,
    () => (workspaceId ? terminalStatuses(workspaceId) : EMPTY),
  )
}

/** Panels with a terminal listening on a port. */
export function panelsWithPorts(statuses: TerminalStatuses): Set<string> {
  const out = new Set<string>()
  for (const terminal of Object.values(statuses)) {
    if (terminal.panelId && terminal.ports.length > 0) out.add(terminal.panelId)
  }
  return out
}

/** A working directory to copy for the workspace: the given panel's terminal,
 *  else any terminal's. */
export function terminalCwd(statuses: TerminalStatuses, panelId?: string | null): string | null {
  const all = Object.values(statuses)
  return all.find((t) => panelId && t.panelId === panelId && t.cwd)?.cwd ?? all.find((t) => t.cwd)?.cwd ?? null
}
