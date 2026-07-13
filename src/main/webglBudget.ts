// =============================================================================
// webglBudget — process-wide WebGL context budget for terminals.
//
// Chromium caps live WebGL contexts per GPU PROCESS (~16), shared across every
// BrowserWindow. xterm's WebGL renderer holds one context per terminal, so the
// main window plus detached dock windows can collectively blow past the limit —
// Chromium then silently drops or never-paints the overflow contexts, leaving
// blank terminals. Each renderer's per-window cap can't see the other windows'
// contexts, so it can't prevent the overflow on its own.
//
// This budget is brokered in main, the only process with a cross-window view.
// Renderers request a grant before creating a WebglAddon and release it on
// context loss / terminal dispose; main reclaims a window's grants when it
// closes (a crashed renderer never gets to release).
//
// Pure module: no electron imports, so it unit-tests without a running app. The
// IPC wiring + window-close reclaim live in ipc/terminal.ts.
// =============================================================================

/** Process-wide ceiling on granted WebGL terminal contexts. Held comfortably
 *  below Chromium's ~16 hard limit to leave headroom for non-terminal GPU users
 *  (webview compositors, the occasional 2D/GL canvas). */
export const GLOBAL_MAX_WEBGL_TERMINALS = 12

/** windowId -> panelIds currently holding a grant in that window. */
const grantsByWindow = new Map<number, Set<string>>()

function liveCount(): number {
  let n = 0
  for (const set of grantsByWindow.values()) n += set.size
  return n
}

/**
 * Grant a process-wide WebGL slot to (windowId, panelId).
 *
 * Idempotent: a panel that already holds a grant keeps it and re-grant is free,
 * so a DOM reparent (which disposes + recreates the WebglAddon) reuses its slot
 * without churning the budget. Returns false when the process is at the cap —
 * the caller stays on xterm's DOM renderer, which always paints.
 */
export function requestWebglGrant(windowId: number, panelId: string): boolean {
  const held = grantsByWindow.get(windowId)
  if (held?.has(panelId)) return true
  if (liveCount() >= GLOBAL_MAX_WEBGL_TERMINALS) return false
  const set = held ?? new Set<string>()
  set.add(panelId)
  grantsByWindow.set(windowId, set)
  return true
}

/** Release the grant held by (windowId, panelId), if any. Freed slots become
 *  available to the next requester. Safe to call for a panel that holds none. */
export function releaseWebglGrant(windowId: number, panelId: string): void {
  const set = grantsByWindow.get(windowId)
  if (!set) return
  set.delete(panelId)
  if (set.size === 0) grantsByWindow.delete(windowId)
}

/** Reclaim every grant held by a window — called when it closes or crashes,
 *  since its renderer can no longer release them itself. */
export function reclaimWindowWebglGrants(windowId: number): void {
  grantsByWindow.delete(windowId)
}

/** Current number of granted slots across all windows (tests / diagnostics). */
export function liveWebglGrantCount(): number {
  return liveCount()
}
