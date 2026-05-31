// =============================================================================
// Wire protocol for the cate-control agent feature. Shared by the pi extension
// (src/agent/extensions/cate-control), the renderer dispatcher
// (src/agent/renderer/cateControl.ts), and tests. No React / electron imports.
// =============================================================================

/** Sentinel prefix carried in a pi ctx.ui.input() title to tag a control
 *  request. The renderer intercepts these before the dialog queue. */
export const CATE_SENTINEL = '@@cate-control@@'

export type CateControlAction =
  | 'layout'
  | 'panel'
  | 'browser'
  | 'terminal'

/** Sub-operations of the per-panel `panel` tool. */
export type PanelOp = 'open' | 'close' | 'move'

/** Sub-operations of the `browser` tool. It controls an existing browser panel;
 *  opening a new one is the `panel` tool's job. */
export type BrowserOp =
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'info'
  | 'read'
  | 'eval'
  | 'screenshot'

/** Sub-operations of the `terminal` tool. */
export type TerminalOp = 'run' | 'read'

/** Emitted by the extension (inside the input() title, after CATE_SENTINEL). */
export interface CateControlRequest {
  action: CateControlAction
  params: Record<string, unknown>
}

/** Returned to the extension as the input() value (JSON-stringified). */
export interface CateControlResponse {
  ok: boolean
  result?: unknown
  error?: string
}
