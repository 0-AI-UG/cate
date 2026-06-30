// =============================================================================
// cateAgentBridge — routes a headless Cate Agent session's agent events.
//
// agentStore funnels every AGENT_EVENT whose panelId is a Cate Agent session here
// (instead of into a phantom AgentPanel). Two things happen:
//   - extension_ui_request with a `cate-agent-tools:` envelope → decode {tool,
//     params}, run it via cateAgentTools against the live stores, and reply with
//     the result string through agentUiResponse (closing pi's blocking input()).
//   - lifecycle (turn start/end) + errors → forwarded to the controller (the
//     registered host) so it can advance the observe/execute loops.
//
// Kept in sync with CATE_AGENT_MARKER in src/agent/extensions/cate-agent-tools/index.ts.
// =============================================================================

import type { CateAgentBridgeHost } from './cateAgentTypes'
import { runCateAgentTool } from './cateAgentTools'
import { initCateAgentTerminalExits } from './cateAgentTerminalExits'
import { signalRunEnd } from './cateAgentRunWaiters'
import log from '../lib/logger'

const CATE_AGENT_MARKER = 'cate-agent-tools:'

let host: CateAgentBridgeHost | null = null

/** The controller registers itself so the bridge can resolve context + report
 *  lifecycle. Also arms terminal-exit tracking. */
export function setCateAgentBridgeHost(h: CateAgentBridgeHost): void {
  host = h
  initCateAgentTerminalExits()
}

function reply(panelId: string, id: string, value: string): void {
  try {
    window.electronAPI.agentUiResponse(panelId, { id, value })
  } catch (err) {
    log.warn('[cateAgentBridge] reply failed for %s: %O', panelId, err)
  }
}

/** Decode a `cate-agent-tools:` envelope title into {tool, params}, or null. */
function decodeEnvelope(title: unknown): { tool: string; params: Record<string, unknown> } | null {
  if (typeof title !== 'string' || !title.startsWith(CATE_AGENT_MARKER)) return null
  try {
    const parsed = JSON.parse(title.slice(CATE_AGENT_MARKER.length)) as { tool?: unknown; params?: unknown }
    if (typeof parsed.tool !== 'string') return null
    const params = parsed.params && typeof parsed.params === 'object' ? (parsed.params as Record<string, unknown>) : {}
    return { tool: parsed.tool, params }
  } catch {
    return null
  }
}

/** Handle one agent event for a Cate Agent session. Called by agentStore. */
export function handleCateAgentEvent(panelId: string, event: { type: string; [key: string]: unknown }): void {
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
        reply(panelId, id, JSON.stringify({ ok: false, error: 'Cate Agent session has no context' }))
        return
      }
      console.info('[cateAgent] tool', decoded.tool, decoded.params)
      void runCateAgentTool(ctx, decoded.tool, decoded.params)
        .then((result) => {
          console.info('[cateAgent] tool', decoded.tool, '→', result.slice(0, 200))
          reply(panelId, id, result)
        })
        .catch((err) => {
          log.warn('[cateAgentBridge] tool %s threw: %O', decoded.tool, err)
          console.warn('[cateAgent] tool', decoded.tool, 'threw', err)
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
      console.info('[cateAgent] run end', panelId)
      // Wake anything awaiting this run's completion (e.g. the launcher waiting on
      // a driver) BEFORE the host reconciles and possibly disposes the session.
      signalRunEnd(panelId)
      if (ctx) host.onRunEnd(ctx)
      return
    }

    case 'turn_end':
      return

    case 'error': {
      const message = typeof event.message === 'string' ? event.message : 'agent error'
      console.warn('[cateAgent] error', panelId, message)
      signalRunEnd(panelId)
      if (ctx) host.onError(ctx, message)
      return
    }

    default:
      return
  }
}
