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

/** Sub-operations of the canvas-wide `layout` tool (read + rearrange). */
export type LayoutOp = 'get' | 'arrange'

/** Sub-operations of the per-panel `panel` tool. */
export type PanelOp =
  | 'open'
  | 'focus'
  | 'move'
  | 'resize'
  | 'close'
  | 'preview'

/** Sub-operations of the `terminal` tool. */
export type TerminalOp = 'run' | 'read'

/** Emitted by the extension (inside the input() title, after CATE_SENTINEL). */
export interface CateControlRequest {
  action: CateControlAction
  params: Record<string, unknown>
}

/** Returned to the extension as the input() value (JSON-stringified).
 *  Invariant: `denied: true` implies `ok: false` and `result` is undefined. */
export interface CateControlResponse {
  ok: boolean
  result?: unknown
  error?: string
  denied?: boolean
}

export type CateActionClass = 'safe' | 'side-effect'

/** A url that does not hit the network (local preview) stays safe. */
function isRemoteUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  return /^https?:\/\//i.test(url)
}

/** Static classification + per-call escalation. Drives whether guarded mode
 *  requires approval. Pure — no side effects. Only destructive (close) and
 *  outbound (run a command, open/navigate a remote url) ops escalate; reads,
 *  focus, and pure layout stay safe. */
export function classifyCateAction(
  action: CateControlAction,
  params: Record<string, unknown>,
): CateActionClass {
  switch (action) {
    case 'terminal':
      // run a command = side-effect; read output = safe.
      return String(params.op ?? '') === 'read' ? 'safe' : 'side-effect'
    case 'browser':
      // navigating to a remote url sends a request; a local file:// preview is safe.
      return isRemoteUrl(params.url) ? 'side-effect' : 'safe'
    case 'panel': {
      const op = String(params.op ?? '')
      if (op === 'open') {
        const target = (params.target ?? {}) as Record<string, unknown>
        if (typeof target.command === 'string' && target.command.trim()) return 'side-effect'
        if (isRemoteUrl(target.url)) return 'side-effect'
        return 'safe'
      }
      if (op === 'close') return 'side-effect'
      return 'safe'
    }
    default:
      return 'safe' // layout (get / arrange) — never destructive or outbound
  }
}
