// =============================================================================
// agentCursor — the channel that makes agent-driven browsing VISIBLE.
//
// Input from `cate.browser.*` is delivered with webContents.sendInputEvent, which
// is indistinguishable from a real user's input: the page reacts, but nothing on
// screen explains why. Without a rendered cursor the user watches a page operate
// itself with no idea what the agent targeted or why it clicked there.
//
// The driver publishes one event per action here BEFORE performing it; the
// overlay in BrowserPanel subscribes per panel and draws a ghost pointer, a
// highlight around the target, and a label. This is a pure observation channel —
// dropping an event must never change what the browser actually does, so every
// emit is fire-and-forget and failures are swallowed by the subscriber, not the
// driver.
//
// Coordinates are GUEST viewport pixels (the same space sendInputEvent uses).
// The overlay maps them to its own box, which is 1:1 as long as the webview is
// unzoomed — see AgentCursorOverlay for the mapping.
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
  /** Short human label: 'click "Sign in"', 'type "hello"'. Shown next to the
   *  pointer so the user can read the agent's intent, not just its effect. */
  label: string
}

type Listener = (event: AgentCursorEvent) => void

const listenersByPanelId = new Map<string, Set<Listener>>()

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

/** Trim a value for a cursor label — labels sit next to the pointer, and a long
 *  accessible name (or a pasted paragraph) would cover the page. */
export function cursorLabelText(value: string, max = 32): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
