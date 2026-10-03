// The agent cursor: makes agent-driven browsing visible. The session publishes
// one event per page action before it runs (and the driver's result after), in
// its snapshot, for the view's overlay. Pure observation: it never changes
// what the page does. Coordinates are guest viewport pixels.

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
  /** Drag/scroll destination, when the action moves from x,y to here. */
  toX?: number
  toY?: number
  /** Diagnostic action label. The visual overlay intentionally does not render
   *  it because native commands may contain refs, selectors or entered text. */
  label: string
}
