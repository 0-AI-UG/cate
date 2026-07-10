// =============================================================================
// useAgentTerminalStatus — a live read of one Cate-Agent-controlled terminal for
// the job cards: the coding agent's turn-state (reactive, from statusStore) plus a
// sampled "status line" peeked from the live xterm buffer. This is what makes a
// card answer "is it working or stuck?" without opening the terminal.
//
// The turn-state is the reliable signal; the sampled line is a best-effort peek of
// whatever the TUI is currently showing (the spinner/progress line), refreshed on a
// slow interval so it reads as a glance, not a transcript.
// =============================================================================

import { useEffect, useState } from 'react'
import { useStatusStore } from '../stores/statusStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import type { AgentState } from '../../shared/types'

// Lines that are pure box-drawing / prompt chrome carry no progress info — skip them
// when hunting for the meaningful status line near the bottom of the screen.
const CHROME_RE = /^[\s│┃╭╰╮╯─━┌┐└┘▏▕|>·•◦*]*$/
const INPUT_PROMPT_RE = /^[?>$#❯➜]/

/** Peek the most recent meaningful line the TUI is rendering (its spinner/progress
 *  line), skipping blank lines, box borders, and the input prompt. */
function sampleStatusLine(panelId: string): string | null {
  const entry = terminalRegistry.getEntry(panelId)
  if (!entry) return null
  const buf = entry.terminal.buffer.active
  const total = buf.length
  for (let i = total - 1; i >= Math.max(0, total - 14); i--) {
    const line = buf.getLine(i)
    const text = line ? line.translateToString(true).trim() : ''
    if (!text || CHROME_RE.test(text) || INPUT_PROMPT_RE.test(text)) continue
    return text.length > 80 ? text.slice(0, 80) + '…' : text
  }
  return null
}

export interface AgentTerminalStatus {
  agentState: AgentState | null
  /** A peek of the terminal's current status line, or null when unavailable. */
  line: string | null
}

export function useAgentTerminalStatus(wsId: string, panelId: string): AgentTerminalStatus {
  const ptyId = terminalRegistry.ptyIdForPanel(panelId) ?? undefined
  const agentState = useStatusStore((s) => (ptyId ? s.workspaces[wsId]?.terminals[ptyId]?.agentState ?? null : null))
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      if (alive) setLine(sampleStatusLine(panelId))
    }
    tick()
    const id = setInterval(tick, 1200)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [panelId])
  return { agentState, line }
}

/** Short human label for a coding agent's turn-state. */
export function agentStateLabel(state: AgentState | null): string {
  switch (state) {
    case 'running':
      return 'Working…'
    case 'waitingForInput':
      return 'Waiting for input'
    case 'finished':
      return 'Finished'
    case 'notRunning':
      return 'Starting…'
    default:
      return 'Starting…'
  }
}
