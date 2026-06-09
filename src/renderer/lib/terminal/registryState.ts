// =============================================================================
// registryState — the shared mutable maps + identity bimap that every other
// terminal module reads/writes through.
//
// The registry is panelId-keyed; each entry carries its ptyId + workspaceId.
// setPtyForPanel is the single writer of both registry+ptyToPanel. Lookup /
// query accessors live here too so higher layers import down, never up.
// =============================================================================

import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import type { SearchAddon } from '@xterm/addon-search'
import type { SerializeAddon } from '@xterm/addon-serialize'
import { setTerminalWorkspaceResolver } from '../../stores/statusStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  terminal: Terminal
  fitAddon: FitAddon
  webglAddon: WebglAddon | null
  searchAddon: SearchAddon
  /** Serializes the buffer (text + styling + cursor + modes) into a string that
   *  restores the terminal verbatim when written to a fresh xterm. Used by the
   *  cross-window transfer path so a detached terminal keeps its colors and
   *  exact frame, not just plain text. Created once with the terminal and never
   *  recreated, so (unlike webglAddon) it is non-null for a live entry. */
  serializeAddon: SerializeAddon
  ptyId: string
  /** Cleanup functions for IPC listeners and xterm disposables. */
  cleanupListeners: Array<() => void>
  /** Last known viewport scrollTop — continuously tracked for scroll restore on focus. */
  lastScrollTop: number
  /**
   * Saved buffer scroll position captured when the panel is hidden/detached, so
   * it can be restored after the xterm DOM element is re-parented (and the
   * browser zeroes its scrollTop) on the next attach(). Uses the buffer LINE
   * index (viewportY) rather than pixel scrollTop because scrollTop is reset by
   * the reparent and stale after fit() changes the row count. `atBottom` lets a
   * follow-output terminal snap to the freshest line instead of an old index.
   */
  savedViewport?: { line: number; atBottom: boolean }
  /** True once a scroll listener has been attached — prevents duplicates across re-attach cycles. */
  hasScrollListener: boolean
  /**
   * True once a document visibilitychange listener has been attached. The
   * WebGL renderer's drawing buffer comes up blank (preserveDrawingBuffer is
   * false) whenever the window paints fresh — a detached window revealed after
   * being created hidden, or any window restored from minimized. The listener
   * forces an atlas rebuild + redraw on the visible transition so the terminal
   * doesn't stay blank/garbled. Flagged so re-attach cycles don't stack copies.
   */
  hasVisibilityListener: boolean
  /** Owning workspace — used to route auto-detected URLs to the right browser panel. */
  workspaceId: string
  /**
   * Whether the underlying PTY is still alive. Set false on TERMINAL_EXIT so
   * registry membership != liveness: the entry lingers (so its xterm buffer /
   * scrollback can still be read and so a re-attach shows the "[Process exited]"
   * line) but callers can tell a self-exited terminal from a live one. Cleared
   * only by dispose() removing the entry entirely.
   */
  alive: boolean
  /**
   * Set during reconnectTerminal when scrollback + panelTransferAck must be
   * deferred until attach() has opened the fresh xterm into its real
   * container. Without this, the scrollback would be written and PTY data
   * flushed into an unopened 80×24-default xterm, baking wrap artifacts and
   * desynced alt-screen state into the buffer before the real container
   * dimensions are known. Cleared once finalized.
   */
  pendingReconnect?: { ptyId: string; scrollback?: string }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

export const registry = new Map<string, RegistryEntry>()

// ---------------------------------------------------------------------------
// Terminal identity bimap (single source of truth for panelId<->ptyId).
//
// The registry is panelId-keyed and each entry carries its ptyId + workspaceId,
// so panelId->ptyId / panelId->workspaceId are direct reads. ptyId->panelId is
// the inverse; rather than the old O(n) scan over every entry (panelIdForPty),
// keep an explicit reverse index updated only where a ptyId is assigned or
// cleared (setPtyForPanel / dispose / release). This is the one place the
// panelId<->ptyId fact lives — statusStore no longer keeps a parallel
// ptyId->workspaceId map; it resolves through workspaceIdForPty() here.
//
// NOTE: this is the RENDERER bimap. Main's terminalOwners / terminalCompanion
// are distinct facts in a different process and are intentionally NOT folded in.
// ---------------------------------------------------------------------------
export const ptyToPanel = new Map<string, string>()

// Let statusStore resolve a ptyId's workspace through this bimap instead of
// keeping a parallel ptyId->workspaceId map. Installed once at module load.
setTerminalWorkspaceResolver((ptyId: string) => {
  const panelId = ptyToPanel.get(ptyId)
  if (!panelId) return undefined
  return registry.get(panelId)?.workspaceId
})

/** Record (or clear) the ptyId for a panel and keep the reverse index in sync.
 *  Pass an empty ptyId to clear (e.g. before a real id is known). */
export function setPtyForPanel(panelId: string, ptyId: string): void {
  const entry = registry.get(panelId)
  if (entry) {
    // Drop any prior reverse mapping for this panel's old ptyId.
    if (entry.ptyId && entry.ptyId !== ptyId) ptyToPanel.delete(entry.ptyId)
    entry.ptyId = ptyId
  }
  if (ptyId) ptyToPanel.set(ptyId, panelId)
}

// Transfer data deposited by shell code before TerminalPanel mounts in a new
// window.  getOrCreate() checks this map and enters reconnect mode if found.
export const pendingTransfers = new Map<string, { ptyId: string; scrollback?: string }>()

// Per-panel last-known create failure, surfaced by TerminalPanel as a Retry
// overlay so a dead panel can recover without restarting the app.
export const failures = new Map<string, string>()
export const failureListeners = new Set<(panelId: string) => void>()
export function notifyFailure(panelId: string): void {
  for (const fn of failureListeners) {
    try { fn(panelId) } catch { /* ignore listener errors */ }
  }
}

// ---------------------------------------------------------------------------
// Lookup / query accessors
// ---------------------------------------------------------------------------

/** Returns the RegistryEntry for panelId, or undefined if not present. */
export function getEntry(panelId: string): RegistryEntry | undefined {
  return registry.get(panelId)
}

/** Returns the last create-failure message for panelId, or null. */
export function getFailure(panelId: string): string | null {
  return failures.get(panelId) ?? null
}

/** Subscribe to failure-state changes for any panel. Returns an unsubscribe fn. */
export function subscribeFailure(listener: (panelId: string) => void): () => void {
  failureListeners.add(listener)
  return () => failureListeners.delete(listener)
}

/** Returns true if an entry exists for panelId. */
export function has(panelId: string): boolean {
  return registry.has(panelId)
}

/**
 * Iterate over every registered terminal. Used by the agent-screen detector
 * to poll each xterm buffer for prompt markers.
 */
export function entries(): Array<[string, RegistryEntry]> {
  return Array.from(registry.entries())
}

/** Reverse lookup: find panelId by ptyId (O(1) via the bimap). */
export function panelIdForPty(ptyId: string): string | null {
  return ptyToPanel.get(ptyId) ?? null
}

/** Forward lookup: ptyId for a panel, or null if not yet assigned / unknown. */
export function ptyIdForPanel(panelId: string): string | null {
  const id = registry.get(panelId)?.ptyId
  return id ? id : null
}

/** Owning workspace for a ptyId, resolved through the bimap + registry entry.
 *  This is the single source statusStore + its consumers read instead of a
 *  parallel ptyId->workspaceId map. */
export function workspaceIdForPty(ptyId: string): string | undefined {
  const panelId = ptyToPanel.get(ptyId)
  if (!panelId) return undefined
  return registry.get(panelId)?.workspaceId
}

/** Owning workspace for a panelId. */
export function workspaceIdForPanel(panelId: string): string | undefined {
  return registry.get(panelId)?.workspaceId
}

/** Whether the PTY behind a panel is still alive (false after TERMINAL_EXIT,
 *  true while running, undefined when there is no entry). */
export function isAlive(panelId: string): boolean | undefined {
  return registry.get(panelId)?.alive
}
