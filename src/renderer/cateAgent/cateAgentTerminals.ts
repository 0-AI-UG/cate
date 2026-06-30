// =============================================================================
// cateAgentTerminals — low-level terminal primitives for the Cate Agent.
//
// The Cate Agent drives real canvas terminals: it opens them in a worktree, reads
// their rendered screen + agent turn-state, and closes them. These primitives are
// shared by the tool dispatch (cateAgentTools) and the per-iteration driver runner
// (codingAgentLauncher), so they live in this leaf module to keep both free of a
// circular import.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useStatusStore } from '../stores/statusStore'
import { useCateAgentStore } from './cateAgentStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { getWorkspaceCanvasStore } from '../lib/workspace/canvasAccess'
import { viewToCanvas } from '../lib/canvas/coordinates'
import { nudgeToFree } from '../canvas/placement'
import { resolvePanelSize } from '../../shared/panels'
import type { Point, AgentState } from '../../shared/types'
import { getExitCode, clearExit } from './cateAgentTerminalExits'
import log from '../lib/logger'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Length of the id prefix the agent sees. The agent only ever reads/echoes this
 *  prefix; the full id is kept internally and recovered by prefix match (see
 *  resolveTerminalId / resolveIterationId in cateAgentTools). Collisions are
 *  astronomically unlikely for UUID-derived ids. */
export const SHORT_ID_LEN = 8

/** Trim a real id down to the prefix shown to the agent. */
export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LEN)
}

/** Resolve the ptyId for a terminal handle (the handle IS the panelId). */
export function ptyFor(panelId: string): string | undefined {
  return terminalRegistry.ptyIdForPanel(panelId) ?? undefined
}

export function activityRunning(wsId: string, ptyId: string): boolean {
  const act = useStatusStore.getState().workspaces[wsId]?.terminalActivity[ptyId]
  return act?.type === 'running'
}

export function agentStateFor(wsId: string, ptyId: string): AgentState | null {
  return useStatusStore.getState().workspaces[wsId]?.agentState[ptyId] ?? null
}

/** True while a terminal is doing work — a coding-agent CLI mid-turn or a live
 *  shell command. Parked / exited / idle => NOT busy. */
export function terminalBusy(wsId: string, panelId: string): boolean {
  const ptyId = ptyFor(panelId)
  if (!ptyId) return false
  if (getExitCode(ptyId) !== null) return false
  const aState = agentStateFor(wsId, ptyId)
  if (aState) return aState === 'running'
  return activityRunning(wsId, ptyId)
}

/** Close a terminal panel through the single disposal path, cleaning up the
 *  per-terminal bookkeeping (glow set + exit tracking). */
export function closeCanvasPanel(wsId: string, panelId: string): void {
  const ptyId = ptyFor(panelId)
  try {
    useAppStore.getState().closePanel(wsId, panelId)
  } catch (err) {
    log.warn('[cateAgentTerminals] closePanel failed: %O', err)
  }
  useCateAgentStore.getState().removeControlledTerminal(wsId, panelId)
  if (ptyId) clearExit(ptyId)
}

/** Compute an EXPLICIT canvas-space position so a Cate Agent terminal auto-places
 *  silently (never the interactive "click to place" ghost). Anchors at the viewport
 *  centre (fanned per index so a burst doesn't pile on one spot), then lets
 *  `nudgeToFree` push it off any existing panel — including the terminals earlier
 *  iterations just opened — so agent terminals never land on top of the user's work. */
function terminalPosition(wsId: string, index: number): Point | undefined {
  const store = getWorkspaceCanvasStore(wsId)
  if (!store) return undefined // no canvas → panel docks (no ghost), leave undefined
  const s = store.getState()
  const size = resolvePanelSize('terminal')
  const center = { x: s.containerSize.width / 2, y: s.containerSize.height / 2 }
  const canvasCenter = viewToCanvas(center, s.zoomLevel, s.viewportOffset)
  const desired = {
    x: canvasCenter.x - size.width / 2 + index * 40,
    y: canvasCenter.y - size.height / 2 + index * 40,
  }
  return nudgeToFree(s.nodes, size, desired)
}

/** Wait until a freshly created panel has a live pty, or give up. */
async function waitForPty(panelId: string, timeoutMs = 8000): Promise<string | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ptyId = ptyFor(panelId)
    if (ptyId) return ptyId
    await sleep(120)
  }
  return ptyFor(panelId)
}

/** Open a visible canvas terminal in `cwd`, register it for activity polling, and
 *  light it up in `glow`. Returns the panelId (the terminal handle). */
export async function openTerminal(wsId: string, cwd: string, glow: string, index: number, worktreeId?: string): Promise<string> {
  const app = useAppStore.getState()
  const pos = terminalPosition(wsId, index)
  const panelId = app.createTerminal(wsId, undefined, pos, { target: 'canvas' }, cwd)
  if (worktreeId) app.setPanelWorktreeId(wsId, panelId, worktreeId)
  useCateAgentStore.getState().addControlledTerminal(wsId, panelId, glow)
  const ptyId = await waitForPty(panelId)
  if (ptyId) {
    try {
      await window.electronAPI.shellRegisterTerminal(ptyId)
    } catch {
      /* activity polling is best-effort */
    }
  }
  return panelId
}

/** Read a terminal's CURRENT RENDERED SCREEN as plain text from its live xterm
 *  buffer — what the user actually sees (TUI agents repaint, so the raw log is
 *  redraw spam). Returns null when the terminal isn't mounted. */
function readScreenText(panelId: string, maxLines = 200): string | null {
  const entry = terminalRegistry.getEntry(panelId)
  if (!entry) return null
  const buf = entry.terminal.buffer.active
  const total = buf.length
  const start = Math.max(0, total - maxLines)
  const lines: string[] = []
  for (let i = start; i < total; i++) {
    const line = buf.getLine(i)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n').replace(/\n+$/, '')
}

export interface TerminalState {
  output: string
  isRunning: boolean
  lastExitCode: number | null
  agentState: AgentState | null
}

export async function readTerminalState(wsId: string, panelId: string): Promise<TerminalState> {
  const ptyId = ptyFor(panelId)
  if (!ptyId) return { output: '', isRunning: false, lastExitCode: null, agentState: null }
  let output = readScreenText(panelId)
  if (output === null) {
    try {
      const raw = (await window.electronAPI.terminalLogRead(ptyId)) ?? ''
      output = raw.length > 6000 ? raw.slice(-6000) : raw
    } catch {
      output = ''
    }
  }
  return {
    output,
    isRunning: activityRunning(wsId, ptyId),
    lastExitCode: getExitCode(ptyId),
    agentState: agentStateFor(wsId, ptyId),
  }
}
