// =============================================================================
// Terminal IPC handlers — terminal session layer over a companion ProcessHost.
//
// The PTY mechanics (spawn/write/resize/kill, data/exit, visibility-driven
// idle-suspend, process-group teardown) live in the companion's ProcessHost —
// local or remote, identically; this module never branches on where a terminal
// runs. It owns only the SESSION concerns that are main-process / window-aware:
//   - which window owns each terminal (cross-window transfer)
//   - 16ms output coalescing → IPC to the owner window
//   - disk logging / scrollback
// A terminal id is mapped to its companion so write/resize/kill route correctly.
// =============================================================================

import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  TERMINAL_CREATE,
  TERMINAL_WRITE,
  TERMINAL_RESIZE,
  TERMINAL_KILL,
  TERMINAL_DATA,
  TERMINAL_EXIT,
  TERMINAL_GET_CWD,
  TERMINAL_LOG_READ,
  TERMINAL_SCROLLBACK_SAVE,
  TERMINAL_SET_VISIBILITY,
} from '../../shared/ipc-channels'
import { getOrCreateLogger, removeLogger, flushAll as flushAllLoggers, disposeAll as disposeAllLoggers } from './terminalLogger'
import { sendToWindow, windowFromEvent, onWindowClosed } from '../windowRegistry'
import { countTerminalData } from '../perf/perfMonitor'
import { parseLocator, type CompanionId } from '../companion/locator'
import { companions } from '../companion/companionManager'
import type { Companion } from '../companion/types'

// Set true during app shutdown so PTY data/exit callbacks no-op instead of
// calling into a torn-down JS environment.
let shuttingDown = false

// Which window owns each terminal (windowId)
const terminalOwners: Map<string, number> = new Map()

// Which companion hosts each terminal — routes write/resize/kill/getCwd.
const terminalCompanion: Map<string, CompanionId> = new Map()

function companionForTerminal(id: string): Companion | null {
  const cid = terminalCompanion.get(id)
  if (!cid) return null
  try {
    return companions.resolve(cid)
  } catch {
    return null
  }
}

/** Resolve the companion hosting a terminal — used by the shell process monitor
 *  (shell.ts) to route ps/lsof scans to the terminal's host (local or daemon). */
export function getCompanionForTerminal(id: string): Companion | null {
  return companionForTerminal(id)
}

// =============================================================================
// Terminal transfer buffering — holds PTY output during cross-window migration
// =============================================================================

interface TerminalTransferState {
  buffer: Buffer[]
  bufferSize: number
  targetWindowId: number
  /** Fallback timer (cleared on ack / re-begin / completion). */
  timer: ReturnType<typeof setTimeout>
}

const transferStates = new Map<string, TerminalTransferState>()
const MAX_TRANSFER_BUFFER = 64 * 1024
const TRANSFER_TIMEOUT_MS = 5000

/** Hand ownership to `targetWindowId`, flush the buffered output there, and end
 *  the transfer. Used by both the explicit ack and the fallback paths. The
 *  source's view is already gone by the time we transfer (detach releases the
 *  source xterm), so output always follows the panel to the target. */
function completeTerminalTransfer(ptyId: string, targetWindowId: number): void {
  const state = transferStates.get(ptyId)
  if (!state) return
  clearTimeout(state.timer)
  transferStates.delete(ptyId)
  terminalOwners.set(ptyId, targetWindowId)
  for (const chunk of state.buffer) {
    try { sendToWindow(targetWindowId, TERMINAL_DATA, ptyId, chunk.toString()) } catch { /* target gone */ }
  }
}

export function beginTerminalTransfer(ptyId: string, targetWindowId: number): void {
  // Re-begin is normal: detach buffers with a -1 placeholder, then re-points at
  // the real window id once it exists. Carry the buffer forward and CLEAR the
  // previous timer — otherwise a stale 5s timeout fires mid-transfer and tears
  // down the live state, and the second begin would drop already-buffered bytes.
  const existing = transferStates.get(ptyId)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => completeTerminalTransfer(ptyId, targetWindowId), TRANSFER_TIMEOUT_MS)
  transferStates.set(ptyId, {
    buffer: existing?.buffer ?? [],
    bufferSize: existing?.bufferSize ?? 0,
    targetWindowId,
    timer,
  })
}

export function acknowledgeTerminalTransfer(ptyId: string): void {
  const state = transferStates.get(ptyId)
  if (!state) return
  completeTerminalTransfer(ptyId, state.targetWindowId)
}

/** A window was destroyed. Any transfer whose SOURCE was that window is
 *  completed to its target now (the running PTY follows the panel instead of
 *  pointing at a dead owner); any transfer whose TARGET died is abandoned. */
export function handleWindowClosedTerminalTransfers(windowId: number): void {
  for (const [ptyId, state] of [...transferStates]) {
    if (state.targetWindowId === windowId) {
      clearTimeout(state.timer)
      transferStates.delete(ptyId)
    } else if (terminalOwners.get(ptyId) === windowId) {
      completeTerminalTransfer(ptyId, state.targetWindowId)
    }
  }
}

export function getTerminalOwner(terminalId: string): number | undefined {
  return terminalOwners.get(terminalId)
}

export function handleCrossWindowDropTerminalTransfer(ptyId: string | undefined, targetWindowId: number): void {
  if (!ptyId) return
  beginTerminalTransfer(ptyId, targetWindowId)
}

export function reassignTerminalWindow(terminalId: string, newWindowId: number): void {
  terminalOwners.set(terminalId, newWindowId)
}

// =============================================================================
// Spawn / lifecycle — routed through the resolved companion's ProcessHost.
// =============================================================================

function cleanupTerminal(id: string): void {
  terminalOwners.delete(id)
  terminalCompanion.delete(id)
}

async function spawnTerminal(
  options: { cols: number; rows: number; cwd?: string; shell?: string; workspaceId?: string },
  ownerWindowId: number,
): Promise<string> {
  const { companionId, path: cwdPath } = parseLocator(options.cwd ?? '')
  const companion = companions.resolve(companionId)

  // Resolve the cwd through the companion: the local one validates against its
  // allowed roots, the remote one trusts the locator path (its daemon validates).
  // An empty cwd is defaulted to the host's home dir inside the ProcessHost, so
  // there's nothing host-specific to decide here. The owning workspace id scopes
  // validation to that workspace's roots when supplied.
  const cwd = options.cwd ? companion.validateCwd(cwdPath, ownerWindowId, options.workspaceId) : ''

  // Per-terminal output coalescing (16ms) → owner window. Owner is read at flush
  // time so a cross-window transfer reroutes in-flight output.
  let dataBuffer = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const onData = (id: string, data: string): void => {
    if (shuttingDown) return
    countTerminalData(data.length)
    getOrCreateLogger(id).append(data)

    const transferState = transferStates.get(id)
    if (transferState) {
      const chunk = Buffer.from(data)
      transferState.buffer.push(chunk)
      transferState.bufferSize += chunk.length
      while (transferState.bufferSize > MAX_TRANSFER_BUFFER && transferState.buffer.length > 1) {
        transferState.bufferSize -= transferState.buffer.shift()!.length
      }
      return
    }

    dataBuffer += data
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (dataBuffer) {
          const windowId = terminalOwners.get(id)
          if (windowId != null) {
            try { sendToWindow(windowId, TERMINAL_DATA, id, dataBuffer) } catch { /* window gone */ }
          }
        }
        dataBuffer = ''
      }, 16)
    }
  }

  const onExit = (id: string, exitCode: number): void => {
    if (shuttingDown) return
    const windowId = terminalOwners.get(id)
    cleanupTerminal(id)
    if (windowId != null) sendToWindow(windowId, TERMINAL_EXIT, id, exitCode)
  }

  // The requested shell is the client's preference; each ProcessHost resolves it
  // for its own host (the local resolver, or the daemon's first-existing-of
  // [requested, $SHELL, bash, sh]) — so a path that only exists on the client is
  // handled there, not branched on here.
  const handle = await companion.process.create({ cols: options.cols, rows: options.rows, cwd, shell: options.shell }, onData, onExit)

  terminalCompanion.set(handle.id, companionId)
  terminalOwners.set(handle.id, ownerWindowId)
  if (handle.notice) {
    try { sendToWindow(ownerWindowId, TERMINAL_DATA, handle.id, handle.notice) } catch { /* window gone */ }
  }
  return handle.id
}

function writeTerminal(id: string, data: string): void {
  companionForTerminal(id)?.process.write(id, data)
}

function resizeTerminal(id: string, cols: number, rows: number): void {
  companionForTerminal(id)?.process.resize(id, cols, rows)
}

function killTerminal(id: string): void {
  const logger = getOrCreateLogger(id)
  logger.flush()
  removeLogger(id)
  companionForTerminal(id)?.process.kill(id)
  cleanupTerminal(id)
}

export function registerHandlers(): void {
  // Complete/abandon in-flight terminal transfers when a window closes so a
  // running PTY's ownership follows the panel instead of orphaning on a dead window.
  onWindowClosed(handleWindowClosedTerminalTransfers)

  ipcMain.handle(
    TERMINAL_CREATE,
    async (event, options: { cols: number; rows: number; cwd?: string; shell?: string }): Promise<string> => {
      const win = windowFromEvent(event)
      const windowId = win?.id ?? -1
      return spawnTerminal(options, windowId)
    },
  )

  ipcMain.handle(TERMINAL_WRITE, async (_event, terminalId: string, data: string) => {
    writeTerminal(terminalId, data)
  })

  ipcMain.handle(TERMINAL_RESIZE, async (_event, terminalId: string, cols: number, rows: number) => {
    resizeTerminal(terminalId, cols, rows)
  })

  ipcMain.handle(TERMINAL_KILL, async (_event, terminalId: string) => {
    killTerminal(terminalId)
  })

  ipcMain.handle(TERMINAL_SET_VISIBILITY, async (_event, terminalId: string, visible: boolean) => {
    companionForTerminal(terminalId)?.process.setVisibility(terminalId, visible)
  })

  ipcMain.handle(TERMINAL_GET_CWD, async (_event, ptyId: string): Promise<string | null> => {
    const companion = companionForTerminal(ptyId)
    if (!companion) return null
    return companion.process.getCwd(ptyId)
  })

  ipcMain.handle(TERMINAL_LOG_READ, async (_event, terminalId: string): Promise<string | null> => {
    const { TerminalLogger } = await import('./terminalLogger')
    const logDir = TerminalLogger.getLogDir()
    const scrollbackPath = path.join(logDir, `${terminalId}.scrollback`)
    try {
      const data = fs.readFileSync(scrollbackPath, 'utf-8')
      if (data) return data
    } catch { /* fall through to raw log */ }

    const existing = getOrCreateLogger(terminalId)
    const data = existing.readAll()
    if (!terminalCompanion.has(terminalId)) {
      removeLogger(terminalId)
    }
    return data || null
  })

  ipcMain.handle(TERMINAL_SCROLLBACK_SAVE, async (_event, ptyId: string, content: string): Promise<void> => {
    const { TerminalLogger } = await import('./terminalLogger')
    const logDir = TerminalLogger.getLogDir()
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, `${ptyId}.scrollback`), content, 'utf-8')
  })
}

/**
 * Tear down all terminals on app quit. Local terminals now live in the local
 * companion daemon subprocess, so disposing the companion connections sends each
 * daemon SIGTERM and closes its stdin — its ProcessHost then group-kills its ptys
 * (reaping dev servers/watchers) and exits. Remote daemons are torn down the same
 * way. Fire-and-forget: quit must not block on a remote socket.
 */
export function killAllTerminals(): void {
  shuttingDown = true
  disposeAllLoggers()
  void companions.disposeAll()
  terminalOwners.clear()
  terminalCompanion.clear()
}

export { flushAllLoggers }
