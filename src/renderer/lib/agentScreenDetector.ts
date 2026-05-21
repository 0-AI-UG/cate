// =============================================================================
// Agent screen-state detector
//
// Combines three signals to decide whether an agent is currently working or
// waiting for the user:
//
//   1. Subprocess active (from main's process tree scan). When the agent has
//      spawned a tool command this is unambiguous — it's definitely running.
//      Helpers like `caffeinate` and idle persistent shells are filtered out
//      in main so they don't pin this signal permanently.
//
//   2. Recent buffer changes (from xterm's visible buffer). While the agent
//      streams tokens or animates its "Synthesizing… 3s" timer, the visible
//      buffer text mutates. When it sits idle at the prompt the buffer is
//      static — the cursor blink doesn't change the characters.
//
//   3. Recent user keystrokes (from xterm.onData). A user typing into the
//      prompt also mutates the buffer (the input box re-renders), so naive
//      buffer-stability detection misclassifies typing as "agent running".
//      We discount buffer changes that align with recent user input.
//
// Decision:   running  iff  subprocessActive  OR  (bufferRecent  AND  !userInputRecent)
//             waiting  otherwise
// =============================================================================

import { terminalRegistry } from './terminalRegistry'
import { useStatusStore } from '../stores/statusStore'
import type { Terminal, IDisposable } from '@xterm/xterm'
import type { AgentState } from '../../shared/types'

const POLL_MS = 250
// How long after a buffer change the agent is still considered "active". Long
// enough to absorb token-throttle pauses in Claude's streaming.
const BUFFER_ACTIVE_WINDOW_MS = 1200
// How long after a keystroke that change is attributed to the user. Covers the
// echo + a small typing cadence so consecutive keystrokes stay classified as
// typing, not agent output.
const USER_INPUT_WINDOW_MS = 600

// -----------------------------------------------------------------------------
// Per-terminal tracking
// -----------------------------------------------------------------------------

interface Tracker {
  lastSnapshot: string
  lastBufferChangeAt: number
  lastUserInputAt: number
  lastReported: AgentState | null
  inputDisposable: IDisposable | null
}

const trackers = new Map<string, Tracker>()

function attachInputListener(terminal: Terminal, t: Tracker): void {
  // xterm.onData fires for user keystrokes (anything that would be sent to the
  // PTY). We don't care what was typed — only that the user touched the
  // keyboard, so a buffer change at the same moment is attributable to them.
  t.inputDisposable = terminal.onData(() => {
    t.lastUserInputAt = Date.now()
  })
}

function trackerFor(ptyId: string, terminal: Terminal, now: number): Tracker {
  let t = trackers.get(ptyId)
  if (!t) {
    t = {
      lastSnapshot: '',
      lastBufferChangeAt: now,
      lastUserInputAt: 0,
      lastReported: null,
      inputDisposable: null,
    }
    trackers.set(ptyId, t)
    attachInputListener(terminal, t)
  }
  return t
}

function disposeTracker(ptyId: string): void {
  const t = trackers.get(ptyId)
  if (!t) return
  t.inputDisposable?.dispose()
  trackers.delete(ptyId)
}

// -----------------------------------------------------------------------------
// Buffer snapshot
// -----------------------------------------------------------------------------

function snapshotVisible(terminal: Terminal): string {
  const buf = terminal.buffer.active
  const top = buf.viewportY
  const bottom = top + terminal.rows - 1
  let out = ''
  for (let y = top; y <= bottom; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    out += line.translateToString(true) + '\n'
  }
  return out
}

// -----------------------------------------------------------------------------
// Polling loop
// -----------------------------------------------------------------------------

let intervalHandle: ReturnType<typeof setInterval> | null = null

function tick(): void {
  const now = Date.now()
  const status = useStatusStore.getState()
  const api = window.electronAPI

  // Garbage-collect trackers whose terminal vanished (panel closed, etc.).
  const alivePtyIds = new Set<string>()

  for (const [, entry] of terminalRegistry.entries()) {
    const ptyId = entry.ptyId
    if (!ptyId) continue
    alivePtyIds.add(ptyId)

    const workspaceId = status.terminalWorkspaceMap[ptyId]
    if (!workspaceId) continue
    const ws = status.workspaces[workspaceId]
    if (!ws) continue
    const agentName = ws.agentName[ptyId] ?? null
    if (!agentName) {
      // No agent in this terminal — drop the tracker so a static idle shell
      // doesn't get classified as an agent waiting for input.
      disposeTracker(ptyId)
      continue
    }

    const subprocessActive = ws.subprocessActive[ptyId] === true
    const t = trackerFor(ptyId, entry.terminal, now)

    const snap = snapshotVisible(entry.terminal)
    if (snap !== t.lastSnapshot) {
      t.lastSnapshot = snap
      t.lastBufferChangeAt = now
    }

    const bufferRecent = now - t.lastBufferChangeAt < BUFFER_ACTIVE_WINDOW_MS
    const userInputRecent = now - t.lastUserInputAt < USER_INPUT_WINDOW_MS
    const agentOutputting = bufferRecent && !userInputRecent

    const state: AgentState =
      subprocessActive || agentOutputting ? 'running' : 'waitingForInput'

    if (t.lastReported === state) continue
    t.lastReported = state
    status.setAgentState(workspaceId, ptyId, state, agentName)
    api?.shellReportAgentScreenState?.(ptyId, state)
  }

  // Sweep any trackers whose terminal is gone.
  for (const ptyId of trackers.keys()) {
    if (!alivePtyIds.has(ptyId)) disposeTracker(ptyId)
  }
}

export function startAgentScreenDetector(): void {
  if (intervalHandle) return
  intervalHandle = setInterval(tick, POLL_MS)
}

export function stopAgentScreenDetector(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  for (const ptyId of Array.from(trackers.keys())) disposeTracker(ptyId)
}

/** Apply a screen-state update broadcast from main (originating in another window). */
export function applyRemoteAgentScreenState(ptyId: string, state: AgentState): void {
  const status = useStatusStore.getState()
  const workspaceId = status.terminalWorkspaceMap[ptyId]
  if (!workspaceId) return
  const agentName = status.workspaces[workspaceId]?.agentName[ptyId] ?? null
  status.setAgentState(workspaceId, ptyId, state, agentName)
}
