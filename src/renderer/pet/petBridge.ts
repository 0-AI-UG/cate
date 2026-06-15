// =============================================================================
// petBridge — routes a headless pet session's agent events.
//
// agentStore funnels every AGENT_EVENT whose panelId is a pet session here
// (instead of into a phantom AgentPanel). Two things happen:
//   - extension_ui_request with a `cate-pet-tools:` envelope → decode {tool,
//     params}, run it via petTools against the live stores, and reply with the
//     result string through agentUiResponse (closing pi's blocking input()).
//   - lifecycle (turn start/end) + errors → forwarded to the controller (the
//     registered host) so it can advance the observe/execute loops.
//
// Kept in sync with PET_MARKER in src/agent/extensions/cate-pet-tools/index.ts.
// =============================================================================

import type { PetBridgeHost } from './petTypes'
import { runPetTool } from './petTools'
import { initPetTerminalExits } from './petTerminalExits'
import log from '../lib/logger'

const PET_MARKER = 'cate-pet-tools:'

let host: PetBridgeHost | null = null

/** The controller registers itself so the bridge can resolve context + report
 *  lifecycle. Also arms terminal-exit tracking. */
export function setPetBridgeHost(h: PetBridgeHost): void {
  host = h
  initPetTerminalExits()
}

function reply(panelId: string, id: string, value: string): void {
  try {
    window.electronAPI.agentUiResponse(panelId, { id, value })
  } catch (err) {
    log.warn('[petBridge] reply failed for %s: %O', panelId, err)
  }
}

/** Decode a `cate-pet-tools:` envelope title into {tool, params}, or null. */
function decodeEnvelope(title: unknown): { tool: string; params: Record<string, unknown> } | null {
  if (typeof title !== 'string' || !title.startsWith(PET_MARKER)) return null
  try {
    const parsed = JSON.parse(title.slice(PET_MARKER.length)) as { tool?: unknown; params?: unknown }
    if (typeof parsed.tool !== 'string') return null
    const params = parsed.params && typeof parsed.params === 'object' ? (parsed.params as Record<string, unknown>) : {}
    return { tool: parsed.tool, params }
  } catch {
    return null
  }
}

/** Handle one agent event for a pet session. Called by agentStore. */
export function handlePetAgentEvent(panelId: string, event: { type: string; [key: string]: unknown }): void {
  if (!host) return
  const ctx = host.contextFor(panelId)

  switch (event.type) {
    case 'extension_ui_request': {
      const id = typeof event.id === 'string' ? event.id : null
      const method = typeof event.method === 'string' ? event.method : null
      if (!id) return
      // Non-blocking notifications carry no id we must answer; ignore them.
      if (method !== 'input') return
      const decoded = decodeEnvelope(event.title)
      if (!ctx || !decoded) {
        // Unknown request: answer empty so pi's input() doesn't hang forever.
        reply(panelId, id, JSON.stringify({ ok: false, error: 'pet session has no context' }))
        return
      }
      console.info('[pet] tool', decoded.tool, decoded.params)
      void runPetTool(ctx, decoded.tool, decoded.params)
        .then((result) => {
          console.info('[pet] tool', decoded.tool, '→', result.slice(0, 200))
          reply(panelId, id, result)
        })
        .catch((err) => {
          log.warn('[petBridge] tool %s threw: %O', decoded.tool, err)
          console.warn('[pet] tool', decoded.tool, 'threw', err)
          reply(panelId, id, JSON.stringify({ ok: false, error: String(err) }))
        })
      return
    }

    // Run lifecycle. ONLY agent_end means the run is complete; turn_start keeps
    // the "active" state warm, turn_end is ignored (it fires after every tool).
    case 'agent_start':
    case 'turn_start': {
      if (ctx) host.onRunStart(ctx)
      return
    }

    case 'agent_end': {
      console.info('[pet] run end', panelId)
      if (ctx) host.onRunEnd(ctx)
      return
    }

    case 'turn_end':
      return

    case 'error': {
      const message = typeof event.message === 'string' ? event.message : 'agent error'
      console.warn('[pet] error', panelId, message)
      if (ctx) host.onError(ctx, message)
      return
    }

    default:
      return
  }
}
