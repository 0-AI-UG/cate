// =============================================================================
// Renderer-side dispatcher for the cate-control agent feature. Receives control
// requests intercepted from pi's ctx.ui.input() channel (see agentStore
// handleEvent), resolves the calling chat's workspace/canvas via a registry that
// AgentPanel populates, and runs an executor. Returns a CateControlResponse the
// extension reads back. The feature is a plain on/off (cateControlEnabled): when
// off the extension isn't even installed, so the agent never sees the tools.
// =============================================================================

import type { StoreApi } from 'zustand'
import type { CanvasStore } from '../../renderer/stores/canvasStore'
import { type CateControlRequest, type CateControlResponse, type CateControlAction } from '../../shared/cateControl'
import { useSettingsStore } from '../../renderer/stores/settingsStore'
import log from '../../renderer/lib/logger'

/** Everything an executor needs, resolved per calling chat. */
export interface CateControlContext {
  workspaceId: string
  /** React panelId of the AgentPanel hosting this chat (for isSelf / self-protection). */
  hostPanelId: string
  /** The canvas store for this chat's workspace. */
  canvasStore: StoreApi<CanvasStore>
}

export type CateExecutor = (
  params: Record<string, unknown>,
  ctx: CateControlContext,
  agentKey: string,
) => Promise<CateControlResponse>

const registry = new Map<string, CateControlContext>()

export function registerCateContext(agentKey: string, ctx: CateControlContext): void {
  registry.set(agentKey, ctx)
}
export function unregisterCateContext(agentKey: string): void {
  registry.delete(agentKey)
}

// Executor map is assembled in Tasks 6–7; overridable in tests. Held inside a
// hoisted-function holder (not a top-level `let`) so cateExecutors' import-time
// `setCateExecutors(...)` call is safe even when this module is mid-evaluation
// in the import cycle (cateControl → agentStore → cateExecutors → cateControl).
// A top-level `let`/`const` would be in its temporal dead zone at that point.
function executorHolder(): { map: Partial<Record<CateControlAction, CateExecutor>> | null } {
  const g = executorHolder as unknown as {
    _store?: { map: Partial<Record<CateControlAction, CateExecutor>> | null }
  }
  if (!g._store) g._store = { map: null }
  return g._store
}
export function __setExecutorsForTest(map: Partial<Record<CateControlAction, CateExecutor>> | null): void {
  executorHolder().map = map
}
/** Real registration entry point (Task 7). */
export function setCateExecutors(map: Partial<Record<CateControlAction, CateExecutor>>): void {
  const holder = executorHolder()
  if (!holder.map) holder.map = {}
  Object.assign(holder.map, map)
}

export async function dispatchCateRequest(
  agentKey: string,
  req: CateControlRequest,
): Promise<CateControlResponse> {
  try {
    if (!useSettingsStore.getState().cateControlEnabled) {
      return { ok: false, error: 'Cate control is disabled.' }
    }
    const ctx = registry.get(agentKey)
    if (!ctx) return { ok: false, error: 'No context registered for this chat.' }

    const exec = executorHolder().map?.[req.action]
    if (!exec) return { ok: false, error: `Unknown or unimplemented action: ${req.action}` }
    return await exec(req.params, ctx, agentKey)
  } catch (err) {
    log.warn('[cateControl] dispatch failed for %s: %O', req.action, err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
