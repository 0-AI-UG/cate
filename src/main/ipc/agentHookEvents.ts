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

import { SHELL_AGENT_HOOK_EVENT } from '../../shared/ipc-channels'
import type { AgentHookEvent } from '../../shared/agentHooks'
import { runtimes } from '../runtime/runtimeManager'
import type { RuntimeId } from '../runtime/locator'
import { getTerminalOwner } from './terminal'
import { sendToWindow } from '../windowRegistry'
import { ingestAgentSessionStamp } from './agentSessionStamps'

const unsubs = new Map<RuntimeId, () => void>()

/** Subscribe to each runtime's hook stream as it connects (LOCAL and remote
 *  alike; a reconnect resubscribes on the fresh RemoteRuntime). Call once at
 *  startup, before ensureLocalRuntime kicks off the LOCAL connect. */
export function registerAgentHookForwarding(): void {
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
