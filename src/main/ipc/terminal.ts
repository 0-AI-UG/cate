// =============================================================================
// Terminal IPC handlers — terminal session layer over a runtime ProcessHost.
//
// The PTY mechanics (spawn/write/resize/kill, data/exit, visibility-driven
// idle-suspend, process-group teardown) live in the runtime's ProcessHost —
// local or remote, identically; this module never branches on where a terminal
// runs. It owns only the SESSION concerns that are main-process / window-aware:
//   - which window owns each terminal (cross-window transfer)
//   - 16ms output coalescing → IPC to the owner window
//   - disk logging / scrollback
// A terminal id is mapped to its runtime so write/resize/kill route correctly.
// =============================================================================

import { clipboard, ipcMain } from 'electron'
import fs from 'fs/promises'
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
  TERMINAL_CLIPBOARD_WRITE,
} from '../../shared/ipc-channels'
import { getOrCreateLogger, removeLogger, flushAll as flushAllLoggers, disposeAll as disposeAllLoggers } from './terminalLogger'
import log from '../logger'
import { sendToWindow, windowFromEvent, onWindowClosed } from '../windowRegistry'
import { countTerminalData } from '../perf/perfMonitor'
import { parseLocator, type RuntimeId } from '../runtime/locator'
import { runtimes } from '../runtime/runtimeManager'
import type { Runtime } from '../runtime/types'
import { createStringDispatcher } from './batchedDispatcher'

// Set true during app shutdown so PTY data/exit callbacks no-op instead of
// calling into a torn-down JS environment.
let shuttingDown = false

// Which window owns each terminal (windowId)
const terminalOwners: Map<string, number> = new Map()

// Which runtime hosts each terminal — routes write/resize/kill/getCwd.
const terminalRuntime: Map<string, RuntimeId> = new Map()

function runtimeForTerminal(id: string): Runtime | null {
  const cid = terminalRuntime.get(id)
  if (!cid) return null
  try {
    return runtimes.resolve(cid)
  } catch {
    return null
  }
}

/** Resolve the runtime hosting a terminal — used by the shell process monitor
 *  (shell.ts) to route ps/lsof scans to the terminal's host (local or daemon). */
export function getRuntimeForTerminal(id: string): Runtime | null {
  return runtimeForTerminal(id)
}

// =============================================================================
// Terminal transfer buffering — holds PTY output during cross-window migration
// =============================================================================

interface TerminalTransferState {
  buffer: Buffer[]
  bufferSize: number
  /** null while buffering ahead of a destination that doesn't exist yet
   *  (detach buffers BEFORE the new window is created). */
  targetWindowId: number | null
  /** Fallback timer (cleared on ack / retarget / completion / abort). */
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

/** End a transfer WITHOUT moving ownership: flush the held output back to the
 *  current owner (the move never happened — window creation failed, the target
 *  died, or no destination ever arrived). The source xterm is still attached in
 *  the abort scenarios, so the bytes land where the panel still lives. */
export function abortTerminalTransfer(ptyId: string): void {
  const state = transferStates.get(ptyId)
  if (!state) return
  clearTimeout(state.timer)
  transferStates.delete(ptyId)
  const ownerId = terminalOwners.get(ptyId)
  if (ownerId == null) return
  for (const chunk of state.buffer) {
    try { sendToWindow(ownerId, TERMINAL_DATA, ptyId, chunk.toString()) } catch { /* owner gone */ }
  }
}

/** Start holding PTY output ahead of a move whose destination window does not
 *  exist yet (detach buffers BEFORE createWindow). Until a destination arrives
 *  via setTerminalTransferTarget, the fallback timer ABORTS back to the current
 *  owner — there is no window the transfer could legitimately complete toward. */
export function beginTerminalBuffering(ptyId: string): void {
  const existing = transferStates.get(ptyId)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => abortTerminalTransfer(ptyId), TRANSFER_TIMEOUT_MS)
  transferStates.set(ptyId, {
    buffer: existing?.buffer ?? [],
    bufferSize: existing?.bufferSize ?? 0,
    targetWindowId: null,
    timer,
  })
}

/** Point a transfer at its destination window, starting one if none is armed.
 *  Carries any already-buffered bytes forward and re-arms the fallback timer to
 *  COMPLETE toward the target (a missing ack must not strand the PTY on a dead
 *  source — ownership follows the panel). */
export function setTerminalTransferTarget(ptyId: string, targetWindowId: number): void {
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

/** Begin a transfer whose destination is already known (cross-window drop,
 *  dock-back): buffer + target in one step. */
export function beginTerminalTransfer(ptyId: string, targetWindowId: number): void {
  setTerminalTransferTarget(ptyId, targetWindowId)
}

export function acknowledgeTerminalTransfer(ptyId: string): void {
  const state = transferStates.get(ptyId)
  if (!state) return
  // An ack can only come from a wired receiver, which requires a destination —
  // ignore a stray ack while the transfer is still target-less.
  if (state.targetWindowId == null) return
  completeTerminalTransfer(ptyId, state.targetWindowId)
}

/** A window was destroyed. Any transfer whose SOURCE was that window is
 *  completed to its target now (the running PTY follows the panel instead of
 *  pointing at a dead owner); any transfer whose TARGET died is aborted back
 *  to the still-live owner. */
export function handleWindowClosedTerminalTransfers(windowId: number): void {
  for (const [ptyId, state] of [...transferStates]) {
    if (state.targetWindowId === windowId) {
      abortTerminalTransfer(ptyId)
    } else if (terminalOwners.get(ptyId) === windowId) {
      if (state.targetWindowId != null) {
        completeTerminalTransfer(ptyId, state.targetWindowId)
      } else {
        // Owner died while the transfer had no destination yet — nowhere to
        // flush, drop the held bytes with the window.
        clearTimeout(state.timer)
        transferStates.delete(ptyId)
      }
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
// Spawn / lifecycle — routed through the resolved runtime's ProcessHost.
// =============================================================================

function cleanupTerminal(id: string): void {
  terminalOwners.delete(id)
  terminalRuntime.delete(id)
}

async function spawnTerminal(
  options: { cols: number; rows: number; cwd?: string; shell?: string; workspaceId?: string },
  ownerWindowId: number,
): Promise<string> {
  const { runtimeId, path: cwdPath } = parseLocator(options.cwd ?? '')
  const runtime = runtimes.resolve(runtimeId)

  // Resolve the cwd through the runtime: the local one validates against its
  // allowed roots, the remote one trusts the locator path (its daemon validates).
  // An empty cwd is defaulted to the host's home dir inside the ProcessHost, so
  // there's nothing host-specific to decide here. The owning workspace id scopes
  // validation to that workspace's roots when supplied.
  const cwd = options.cwd ? runtime.validateCwd(cwdPath, ownerWindowId, options.workspaceId) : ''

  // Instant-exit diagnostics (#401): a shell that exits cleanly within this
  // window without ever emitting a byte never became an interactive session
  // (shell startup files exiting, or a PTY that couldn't be allocated). Log it
  // with the resolved shell so the next report carries the cause; the renderer
  // shows the user-facing hint.
  const INSTANT_EXIT_THRESHOLD_MS = 1000
  const spawnedAt = Date.now()
  let sawData = false
  let resolvedShell = ''

  // Per-terminal output coalescing (16ms) → owner window. Owner is read at flush
  // time so a cross-window transfer reroutes in-flight output. The PTY only ever
  // invokes onData with this terminal's own id, so the id captured on first data
  // is the one used at flush.
  let terminalId = ''
  const dispatcher = createStringDispatcher(16, (dataBuffer) => {
    const windowId = terminalOwners.get(terminalId)
    if (windowId != null) {
      try { sendToWindow(windowId, TERMINAL_DATA, terminalId, dataBuffer) } catch { /* window gone */ }
    }
  })

  const onData = (id: string, data: string): void => {
    if (shuttingDown) return
    terminalId = id
    sawData = true
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

    dispatcher.push(data)
  }

  const onExit = (id: string, exitCode: number): void => {
    if (shuttingDown) return
    if (exitCode === 0 && !sawData && Date.now() - spawnedAt < INSTANT_EXIT_THRESHOLD_MS) {
      log.warn(
        '[terminal] %s exited immediately (code 0) with no output — shell %s likely exited from its startup files or no PTY could be allocated',
        id,
        resolvedShell || '(unknown)',
      )
    }
    const windowId = terminalOwners.get(id)
    cleanupTerminal(id)
    if (windowId != null) sendToWindow(windowId, TERMINAL_EXIT, id, exitCode)
  }

  // The requested shell is the client's preference; each ProcessHost resolves it
  // for its own host (the local resolver, or the daemon's first-existing-of
  // [requested, $SHELL, bash, sh]) — so a path that only exists on the client is
  // handled there, not branched on here.
  const handle = await runtime.process.create({ cols: options.cols, rows: options.rows, cwd, shell: options.shell }, onData, onExit)
  resolvedShell = handle.shell ?? ''

  terminalRuntime.set(handle.id, runtimeId)
  terminalOwners.set(handle.id, ownerWindowId)
  if (handle.notice) {
    try { sendToWindow(ownerWindowId, TERMINAL_DATA, handle.id, handle.notice) } catch { /* window gone */ }
  }
  return handle.id
}

function writeTerminal(id: string, data: string): void {
  runtimeForTerminal(id)?.process.write(id, data)
}

function resizeTerminal(id: string, cols: number, rows: number): void {
  runtimeForTerminal(id)?.process.resize(id, cols, rows)
}

function killTerminal(id: string): void {
  const logger = getOrCreateLogger(id)
  logger.flush()
  removeLogger(id)
  runtimeForTerminal(id)?.process.kill(id)
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
    runtimeForTerminal(terminalId)?.process.setVisibility(terminalId, visible)
  })

  ipcMain.handle(TERMINAL_CLIPBOARD_WRITE, async (_event, text: string): Promise<void> => {
    if (typeof text !== 'string') {
      log.warn('[terminal] rejected non-string clipboard write payload')
      return
    }
    clipboard.writeText(text)
  })

  ipcMain.handle(TERMINAL_GET_CWD, async (_event, ptyId: string): Promise<string | null> => {
    const runtime = runtimeForTerminal(ptyId)
    if (!runtime) return null
    return runtime.process.getCwd(ptyId)
  })

  // Scrollback/log file names are derived from ids supplied by the renderer
  // (and, on restore, from hand-editable session.json) and joined into log-dir
  // paths. Accept only a plain single-segment file name so a crafted id cannot
  // escape the log directory via path separators or dot-dot.
  function isSafeLogFileId(id: unknown): id is string {
    return (
      typeof id === 'string' &&
      id.length > 0 &&
      id.length <= 256 &&
      !id.includes('/') &&
      !id.includes('\\') &&
      !id.includes('\0') &&
      id !== '.' &&
      id !== '..'
    )
  }

  ipcMain.handle(TERMINAL_LOG_READ, async (_event, terminalId: string): Promise<string | null> => {
    if (!isSafeLogFileId(terminalId)) {
      log.warn('[terminal] rejected unsafe terminal id for log read: %s', String(terminalId))
      return null
    }
    const { TerminalLogger } = await import('./terminalLogger')
    const logDir = TerminalLogger.getLogDir()
    const scrollbackPath = path.join(logDir, `${terminalId}.scrollback`)
    try {
      const data = await fs.readFile(scrollbackPath, 'utf-8')
      if (data) return data
    } catch { /* fall through to raw log */ }

    const existing = getOrCreateLogger(terminalId)
    const data = existing.readAll()
    if (!terminalRuntime.has(terminalId)) {
      removeLogger(terminalId)
    }
    return data || null
  })

  ipcMain.handle(TERMINAL_SCROLLBACK_SAVE, async (_event, ptyId: string, content: string): Promise<void> => {
    if (!isSafeLogFileId(ptyId)) {
      log.warn('[terminal] rejected unsafe terminal id for scrollback save: %s', String(ptyId))
      return
    }
    const { TerminalLogger } = await import('./terminalLogger')
    const logDir = TerminalLogger.getLogDir()
    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(path.join(logDir, `${ptyId}.scrollback`), content, 'utf-8')
  })
}

/**
 * Tear down all terminals on app quit. Local terminals now live in the local
 * runtime daemon subprocess, so disposing the runtime connections sends each
 * daemon SIGTERM and closes its stdin — its ProcessHost then group-kills its ptys
 * (reaping dev servers/watchers) and exits. Remote daemons are torn down the same
 * way. Fire-and-forget: quit must not block on a remote socket.
 */
export function killAllTerminals(): void {
  shuttingDown = true
  disposeAllLoggers()
  void runtimes.disposeAll()
  terminalOwners.clear()
  terminalRuntime.clear()
}

export { flushAllLoggers }
