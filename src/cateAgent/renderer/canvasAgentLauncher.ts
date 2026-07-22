// =============================================================================
// canvasAgentLauncher — "run a canvas subagent to completion".
//
// The orchestrator's `canvas` tool delegates a layout request here. We spawn ONE
// ephemeral headless Cate Agent session in the `canvas` role, seed it with the
// request, and resolve once its run ends (or a timeout fires). Unlike the driver,
// the canvas subagent's tools are synchronous store mutations — it does all its
// work within a single run and then ends its turn — so there is no worktree,
// no backgrounded-send wake machinery, and no settle loop: one run == done.
// =============================================================================

import { generateId } from '../../renderer/stores/canvas/helpers'
import { createCateAgentSession, promptCateAgent, disposeCateAgent, canvasPanelId } from './cateAgentSession'
import { setContext, deleteContext } from './cateAgentContextRegistry'
import { awaitRunEnd } from './cateAgentRunWaiters'
import type { CateAgentContext } from './cateAgentTypes'
import log from '../../renderer/lib/logger'

/** Wall-clock backstop for a single canvas subagent run. Layout work is a handful
 *  of quick tool turns; this only bounds a model that never stops. */
const CANVAS_SETTLE_TIMEOUT_MS = 5 * 60_000

export interface RunCanvasOpts {
  wsId: string
  rootPath: string
  /** The plain-language layout request from the orchestrator. */
  request: string
  /** The canvas the job is pinned to — the subagent acts on it. */
  canvasPanelId?: string
}

/** Spawn a canvas subagent, seed it with the request, and resolve once its run
 *  ends (or the timeout fires). Returns false if the session could not start. */
export async function runCanvasAgentToCompletion(opts: RunCanvasOpts): Promise<boolean> {
  const panelId = canvasPanelId(generateId())
  const ctx: CateAgentContext = {
    panelId,
    workspaceId: opts.wsId,
    rootPath: opts.rootPath,
    role: 'canvas',
    canvasPanelId: opts.canvasPanelId,
  }
  setContext(panelId, ctx)
  const ok = await createCateAgentSession({ panelId, rootPath: opts.rootPath, workspaceId: opts.wsId, role: 'canvas' })
  if (!ok) {
    deleteContext(panelId)
    log.warn('[canvasAgentLauncher] canvas session failed to start for %s', panelId)
    return false
  }
  void promptCateAgent(panelId, opts.request)
  await awaitRunEnd(panelId, CANVAS_SETTLE_TIMEOUT_MS)
  await disposeCateAgent(panelId)
  deleteContext(panelId)
  return true
}
