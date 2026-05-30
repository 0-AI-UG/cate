// =============================================================================
// Wire protocol for the cate-control agent feature. Shared by the pi extension
// (src/agent/extensions/cate-control), the renderer dispatcher
// (src/agent/renderer/cateControl.ts), and tests. No React / electron imports.
// =============================================================================

/** Sentinel prefix carried in a pi ctx.ui.input() title to tag a control
 *  request. The renderer intercepts these before the dialog queue. */
export const CATE_SENTINEL = '@@cate-control@@'

export type CateControlAction =
  | 'get_layout'
  | 'open_panel'
  | 'close_panel'
  | 'focus_panel'
  | 'move_panel'
  | 'resize_panel'
  | 'arrange'
  | 'run_in_terminal'
  | 'open_url'
  | 'reveal_in_editor'
  | 'set_markdown_preview'
  | 'pan_to'
  | 'zoom'

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

/** Static classification + per-call escalation for open_panel. Drives whether
 *  guarded mode requires approval. Pure — no side effects. */
export function classifyCateAction(
  action: CateControlAction,
  params: Record<string, unknown>,
): CateActionClass {
  switch (action) {
    case 'close_panel':
    case 'run_in_terminal':
    case 'open_url':
      return 'side-effect'
    case 'open_panel': {
      const target = (params.target ?? {}) as Record<string, unknown>
      if (typeof target.command === 'string' && target.command.trim()) return 'side-effect'
      if (isRemoteUrl(target.url)) return 'side-effect'
      return 'safe'
    }
    default:
      return 'safe'
  }
}
