// =============================================================================
// useAgentTerminalStatus — a live read of one Cate-Agent-controlled terminal for
// the job cards: the canonical run status (derived from the run + terminal
// lifecycle) plus a sampled "status line" peeked from the live xterm buffer.
// This makes a card answer "is it working or stuck?" without opening it.
//
// The turn-state is the reliable signal; the sampled line is a best-effort peek of
// whatever the TUI is currently showing (the spinner/progress line), refreshed on a
// slow interval so it reads as a glance, not a transcript.
// =============================================================================

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '../../renderer/stores/appStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { terminalRegistry } from '../../renderer/lib/terminal/terminalRegistry'
import {
  deriveCodingAgentRunStatus,
  type CodingAgentRunStatus,
} from '../../shared/codingAgentRuns'

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
  /** Canonical mission status shared with inspect/wait and window reports. */
  runStatus: CodingAgentRunStatus | null
  /** A peek of the terminal's current status line, or null when unavailable. */
  line: string | null
}

export function useAgentTerminalStatus(wsId: string, panelId: string): AgentTerminalStatus {
  const run = useAppStore((state) =>
    state.workspaces.find((workspace) => workspace.id === wsId)?.panels[panelId]?.codingAgentRun,
  )
  const runtime = useStatusStore((state) => {
    const ptyId = terminalRegistry.ptyIdForPanel(panelId)
    return ptyId ? state.workspaces[wsId]?.terminals[ptyId] : undefined
  })
  const failure = useSyncExternalStore(
    (onChange) => terminalRegistry.subscribeFailure((changedPanelId) => {
      if (changedPanelId === panelId) onChange()
    }),
    () => terminalRegistry.getFailure(panelId),
    () => null,
  )
  const entry = terminalRegistry.getEntry(panelId)
  const runStatus = run
    ? deriveCodingAgentRunStatus(run, {
        terminalStarted: entry !== undefined,
        terminalAlive: entry?.alive === true,
        terminalFailed: failure !== null,
        agentState: runtime?.agentState,
        agentPresent: runtime?.agentPresent === true || Boolean(runtime?.agentName),
      })
    : null
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
  return { runStatus, line }
}

export function codingAgentStatusLabel(status: CodingAgentRunStatus): string {
  switch (status) {
    case 'starting': return 'Starting…'
    case 'working': return 'Working…'
    case 'waiting': return 'Waiting for input'
    case 'ready': return 'Finished'
    case 'stopped': return 'Stopped'
    case 'failed': return 'Failed'
  }
}
