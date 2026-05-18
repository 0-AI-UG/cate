// =============================================================================
// Orchestrator entry point — boots the socket server and IPC sync on app ready;
// tears down on quit. Importers call `startOrchestrator()` once.
// =============================================================================

import log from '../logger'
import { startSocketServer, stopSocketServer, getSocketPath } from './socketServer'
import { registerGraphSync, unregisterGraphSyncForWindow } from './graphSync'
import { setGraphAware } from './commands'
import { refresh as refreshPresets, ensureOverrideStub } from './presets'
import { registerRenderBridge } from './renderBridge'
import { registerPortalWcRouting } from './portalWcMap'
import { clearPopupsForWindow } from './popups'

export { tap as tapTerminalData, disposeTerminal } from './dataTap'
export { setWriter as setPtyWriter } from './ptyBridge'
export { getSocketPath, unregisterGraphSyncForWindow, clearPopupsForWindow }

let started = false

export async function startOrchestrator(): Promise<void> {
  if (started) return
  started = true
  try {
    await startSocketServer()
  } catch (e: any) {
    log.error('Orchestrator: socket server failed to start: %s', e?.message ?? e)
  }
  registerGraphSync()
  registerRenderBridge()
  registerPortalWcRouting()
  try {
    await ensureOverrideStub()
    await refreshPresets()
  } catch (e: any) {
    log.warn('Orchestrator: preset detection failed: %s', e?.message ?? e)
  }
  // Phase B+: the renderer pushes a canvas connection graph in every snapshot,
  // so `cate list` / `check` / `ask` filter to only connected peers. Until two
  // panels are wired together on the canvas (Alt-drag from one tab to another),
  // they cannot see or message each other.
  setGraphAware(true)
}

export async function stopOrchestrator(): Promise<void> {
  if (!started) return
  started = false
  await stopSocketServer()
}

/** Flip on graph-aware listing/check/ask. Phase B calls this after the
 *  renderer has synced its initial connection state. */
export { setGraphAware }
