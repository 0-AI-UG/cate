// =============================================================================
// agentCursor — the channel that makes agent-driven browsing VISIBLE.
//
// Input from `cate.browser.*` is delivered with webContents.sendInputEvent, which
// is indistinguishable from a real user's input: the page reacts, but nothing on
// screen explains why. Without a rendered cursor the user watches a page operate
// itself with no idea what the agent targeted or why it clicked there.
//
// The driver publishes one event per action here BEFORE performing it; the
// overlay in BrowserPanel subscribes per panel and draws a ghost pointer plus
// action-specific motion. This is a pure observation channel —
// dropping an event must never change what the browser actually does, so every
// emit is fire-and-forget and failures are swallowed by the subscriber, not the
// driver.
//
// Coordinates are GUEST viewport pixels. BrowserPanel supplies the page zoom
// and fit-to-panel scale so AgentCursorOverlay maps them onto the rendered page.
// =============================================================================

export type AgentCursorKind =
  | 'move'
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'drag'
  | 'scroll'
  | 'type'
  | 'press'
  | 'done'

export interface AgentCursorEvent {
  kind: AgentCursorKind
  /** Pointer position in guest viewport pixels. Absent for non-positional
   *  actions (a `press` with no ref goes to whatever holds focus). */
  x?: number
  y?: number
  /** Target box in guest viewport pixels: [left, top, width, height]. Drawn as
   *  the highlight the pointer is acting on. */
  rect?: [number, number, number, number]
  /** Drag/scroll destination, when the action moves from x,y to here. */
  toX?: number
  toY?: number
  /** Diagnostic action label. The visual overlay intentionally does not render
   *  it because native commands may contain refs, selectors or entered text. */
  label: string
}

type Listener = (event: AgentCursorEvent) => void

const listenersByPanelId = new Map<string, Set<Listener>>()
const contentListenersByPanelId = new Map<string, Set<() => void>>()

/** Subscribe a panel's overlay. Returns the unsubscribe function. */
export function subscribeAgentCursor(panelId: string, listener: Listener): () => void {
  const set = listenersByPanelId.get(panelId) ?? new Set<Listener>()
  set.add(listener)
  listenersByPanelId.set(panelId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listenersByPanelId.delete(panelId)
  }
}

/** Publish one action. Never throws: a broken overlay must not break browsing. */
export function emitAgentCursor(panelId: string, event: AgentCursorEvent): void {
  const set = listenersByPanelId.get(panelId)
  if (!set) return
  for (const listener of set) {
    try { listener(event) } catch { /* an overlay error is not a driver error */ }
  }
}

/** Notify a hidden native browser slot that an agent action may have changed
 * the rendered page and its cached canvas preview is now stale. */
export function emitBrowserContentChanged(panelId: string): void {
  for (const listener of contentListenersByPanelId.get(panelId) ?? []) listener()
}

export function subscribeBrowserContentChanged(panelId: string, listener: () => void): () => void {
  const set = contentListenersByPanelId.get(panelId) ?? new Set<() => void>()
  set.add(listener)
  contentListenersByPanelId.set(panelId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) contentListenersByPanelId.delete(panelId)
  }
}

/** User input immediately returns control of the panel and removes the agent
 * indicator. The last pointer remains visible until this explicit handoff. */
export function releaseAgentCursor(panelId: string): void {
  emitAgentCursor(panelId, { kind: 'done', label: '' })
}

/** Trim a value for a cursor label — labels sit next to the pointer, and a long
 *  accessible name (or a pasted paragraph) would cover the page. */
export function cursorLabelText(value: string, max = 32): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
