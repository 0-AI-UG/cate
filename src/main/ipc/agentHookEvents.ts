// =============================================================================
// Agent hook event forwarding — the main-process leg of the push-based agent
// hook stream. Each connected runtime's daemon ingests + normalizes hook
// events from the agent CLIs running in its terminals (see
// src/runtime/capabilities/agentHooks.ts); this module subscribes to every
// runtime's stream and re-emits each event to the window that owns the
// terminal, mirroring how SHELL_AGENT_SESSION_UPDATE flows today.
//
// Each event is also fed to the session-stamp tracker (agentSessionStamps.ts),
// the main-side consumer that keeps the terminal-restore stamp current; the
// renderer additionally gets the raw subscription surface
// (onShellAgentHookEvent) for its own features.
// =============================================================================

import { ipcMain } from 'electron'
import { AGENT_HOOKS_INSPECT, SHELL_AGENT_HOOK_EVENT } from '../../shared/ipc-channels'
import type { AgentHookAgentState, AgentHookEvent } from '../../shared/agentHooks'
import { runtimes } from '../runtime/runtimeManager'
import { parseLocator, type RuntimeId } from '../runtime/locator'
import { getTerminalOwner } from './terminal'
import { sendToWindow } from '../windowRegistry'
import { ingestAgentSessionStamp } from './agentSessionStamps'

const unsubs = new Map<RuntimeId, () => void>()

/**
 * Inspect a workspace's per-agent hook-file injection for the Settings UI. The
 * work happens in the agent-hooks capability on whichever host owns the
 * workspace (local daemon or a remote one), so it is correct for remote
 * workspaces too — main just resolves the runtime and forwards the cwd.
 */
async function inspectAgentHooks(locator: string): Promise<AgentHookAgentState[]> {
  const { runtimeId, path: cwd } = parseLocator(locator)
  if (!cwd) return []
  try {
    return await runtimes.resolve(runtimeId).agentHooks.inspectWorkspace(cwd)
  } catch {
    return [] // runtime not connected / inspection failed — no state to show
  }
}

/** Subscribe to each runtime's hook stream as it connects (LOCAL and remote
 *  alike; a reconnect resubscribes on the fresh RemoteRuntime). Call once at
 *  startup, before ensureLocalRuntime kicks off the LOCAL connect. */
export function registerAgentHookForwarding(): void {
  // Settings UI: report a workspace's current per-agent injection state.
  ipcMain.handle(AGENT_HOOKS_INSPECT, (_event, locator: string) => inspectAgentHooks(locator))

  runtimes.onConnected((id, runtime) => {
    unsubs.get(id)?.()
    unsubs.set(
      id,
      runtime.agentHooks.subscribe((event: AgentHookEvent) => {
        // Events are correlated daemon-side via CATE_TERMINAL_ID; a terminal
        // that has no owner (already closed, or an id we never spawned) drops.
        const ownerWindowId = getTerminalOwner(event.terminalId)
        if (ownerWindowId == null) return
        ingestAgentSessionStamp(runtime, event)
        try {
          sendToWindow(ownerWindowId, SHELL_AGENT_HOOK_EVENT, event.terminalId, event)
        } catch { /* window gone */ }
      }),
    )
  })
  runtimes.onDisconnected((id) => {
    unsubs.get(id)?.()
    unsubs.delete(id)
  })
}
