// =============================================================================
// Terminal IPC handlers — manages node-pty terminal processes
// =============================================================================

import { IPty, spawn as ptySpawn } from 'node-pty'
import { ipcMain } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { validateCwd } from './pathValidation'
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
import { sendToWindow, windowFromEvent } from '../windowRegistry'
import { getShellEnv } from '../shellEnv'
import { resolveShell, type ResolvedShell } from '../shellResolver'
import { getSettingSync } from '../store'
import { countTerminalData } from '../perf/perfMonitor'
import log from '../logger'
// Active terminal PTY instances keyed by terminal ID
const terminals: Map<string, IPty> = new Map()

// Set true during app shutdown so PTY data/exit callbacks no-op instead of
// calling into a torn-down JS environment (which aborts via node-pty's
// ThreadSafeFunction CallJS throwing during Environment::CleanupHandles).
let shuttingDown = false

// Shell PIDs keyed by terminal ID — exported for shell.ts process monitor
export const terminalPids: Map<string, number> = new Map()

// Which window owns each terminal (windowId)
const terminalOwners: Map<string, number> = new Map()

// =============================================================================
// Idle-suspend bookkeeping — pauses (SIGSTOP) terminals that are offscreen and
// have produced no PTY output for IDLE_SUSPEND_MS. Resumed (SIGCONT) on focus
// or any user interaction. POSIX-only; no-op on Windows.
// =============================================================================

interface TerminalIdleState {
  /** Idle-suspend timer. Reset on resume — not a pure PTY-output timestamp. */
  lastOutputAt: number
  visible: boolean
  suspended: boolean
}

const idleState: Map<string, TerminalIdleState> = new Map()

const IDLE_SUSPEND_MS = 2 * 60_000
const IDLE_CHECK_INTERVAL_MS = 20_000
let idleScanner: ReturnType<typeof setInterval> | null = null

function suspendTerminal(id: string): void {
  if (process.platform === 'win32') return
  if (!getSettingSync('autoSuspendIdleTerminals')) return
  const pid = terminalPids.get(id)
  const state = idleState.get(id)
  if (!pid || !state || state.suspended) return
  try { process.kill(-pid, 'SIGSTOP') } catch { /* gone */ }
  state.suspended = true
  log.debug('Suspended idle terminal %s (pid=%d)', id, pid)
}

function resumeTerminal(id: string): void {
  const pid = terminalPids.get(id)
  const state = idleState.get(id)
  if (!pid || !state || !state.suspended) return
  try { process.kill(-pid, 'SIGCONT') } catch { /* gone */ }
  state.suspended = false
  state.lastOutputAt = Date.now()
  log.debug('Resumed terminal %s (pid=%d)', id, pid)
}

function scanIdleTerminals(): void {
  if (process.platform === 'win32') return
  if (!getSettingSync('autoSuspendIdleTerminals')) {
    // Setting was turned off at runtime — resume any currently suspended ones.
    for (const [id, state] of idleState) {
      if (state.suspended) resumeTerminal(id)
    }
    return
  }
  const now = Date.now()
  for (const [id, state] of idleState) {
    if (state.visible) continue
    if (state.suspended) continue
    if (now - state.lastOutputAt < IDLE_SUSPEND_MS) continue
    suspendTerminal(id)
  }
}

function ensureIdleScanner(): void {
  if (idleScanner) return
  if (process.platform === 'win32') return
  idleScanner = setInterval(scanIdleTerminals, IDLE_CHECK_INTERVAL_MS)
}

function setTerminalVisibility(id: string, visible: boolean): void {
  const state = idleState.get(id)
  if (!state) return
  state.visible = visible
  if (visible && state.suspended) {
    resumeTerminal(id)
  }
}

// =============================================================================
// Terminal transfer buffering — holds PTY output during cross-window migration
// =============================================================================

interface TerminalTransferState {
  buffer: Buffer[]
  bufferSize: number
  targetWindowId: number
}

const transferStates = new Map<string, TerminalTransferState>()
const MAX_TRANSFER_BUFFER = 64 * 1024 // 64 KB
const TRANSFER_TIMEOUT_MS = 5000

/**
 * Begin buffering PTY output for a terminal being transferred to another window.
 * Output is accumulated until acknowledgeTerminalTransfer() is called.
 */
export function beginTerminalTransfer(ptyId: string, targetWindowId: number): void {
  transferStates.set(ptyId, {
    buffer: [],
    bufferSize: 0,
    targetWindowId,
  })

  // Safety timeout: if ACK never arrives, flush back to source and cancel
  setTimeout(() => {
    const state = transferStates.get(ptyId)
    if (!state) return // already acknowledged
    // Flush buffer to whatever window currently owns the terminal
    const ownerWindowId = terminalOwners.get(ptyId)
    if (ownerWindowId != null) {
      try {
        for (const chunk of state.buffer) {
          sendToWindow(ownerWindowId, TERMINAL_DATA, ptyId, chunk.toString())
        }
      } catch {
        // Owner window may have been destroyed in the meantime — drop the
        // buffered data rather than crashing the transfer cleanup.
      }
    }
    transferStates.delete(ptyId)
  }, TRANSFER_TIMEOUT_MS)
}

/**
 * Complete a terminal transfer: flush buffered output to the new window and
 * update the terminal owner mapping.
 */
export function acknowledgeTerminalTransfer(ptyId: string): void {
  const state = transferStates.get(ptyId)
  if (!state) return

  const { targetWindowId, buffer } = state

  // Update ownership
  terminalOwners.set(ptyId, targetWindowId)

  // Flush buffered data to the target window
  for (const chunk of buffer) {
    sendToWindow(targetWindowId, TERMINAL_DATA, ptyId, chunk.toString())
  }

  transferStates.delete(ptyId)
}

/**
 * Get the owning window ID for a terminal.
 */
export function getTerminalOwner(terminalId: string): number | undefined {
  return terminalOwners.get(terminalId)
}

/**
 * Cross-window drop hook: arm a transfer to `targetWindowId` so the receiver's
 * subsequent panelTransferAck flips ownership. Without this, the target's ACK
 * is a no-op (no transferStates entry) and PTY data keeps routing to the
 * source window, which has already released its xterm — surfacing as the
 * "gray terminal, no input, no output" bug.
 */
export function handleCrossWindowDropTerminalTransfer(
  ptyId: string | undefined,
  targetWindowId: number,
): void {
  if (!ptyId) return
  beginTerminalTransfer(ptyId, targetWindowId)
}

/**
 * Reassign a terminal to a different window (e.g. when dragging a panel out).
 */
export function reassignTerminalWindow(terminalId: string, newWindowId: number): void {
  terminalOwners.set(terminalId, newWindowId)
}

function createTerminal(
  id: string,
  resolved: ResolvedShell,
  cwd: string,
  cols: number,
  rows: number,
  env: Record<string, string>,
  ownerWindowId: number,
): void {
  // Use the resolved shell environment (full PATH from login shell) and
  // strip npm/node env vars injected by electron-vite so they don't leak
  // into user shells (e.g. npm_config_prefix conflicts with nvm)
  const cleanEnv = Object.fromEntries(
    Object.entries(getShellEnv()).filter(
      ([key]) => !key.startsWith('npm_') && !key.startsWith('ELECTRON_'),
    ),
  )

  const ptyProcess = ptySpawn(resolved.path, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...cleanEnv, ...env },
  })

  terminals.set(id, ptyProcess)
  terminalPids.set(id, ptyProcess.pid)
  terminalOwners.set(id, ownerWindowId)
  idleState.set(id, { lastOutputAt: Date.now(), visible: true, suspended: false })
  ensureIdleScanner()

  // Surface fallback details inside the terminal — otherwise users only see
  // a cryptic exit code when their configured shell is missing.
  if (resolved.fallback) {
    const reasonText =
      resolved.reason === 'missing' ? 'not found'
      : resolved.reason === 'not-executable' ? 'not executable'
      : resolved.reason === 'disallowed' ? 'not allowed'
      : 'not set'
    const requested = resolved.requested ?? '(unset)'
    const notice =
      `\x1b[33m[cate] Configured shell '${requested}' is ${reasonText}; ` +
      `using '${resolved.path}' instead. Update Settings → General → Default shell path.\x1b[0m\r\n`
    log.warn(
      'Shell fallback for terminal %s: requested=%s reason=%s using=%s',
      id, requested, resolved.reason, resolved.path,
    )
    sendToWindow(ownerWindowId, TERMINAL_DATA, id, notice)
  }

  // Buffer PTY output and flush at ~60fps to avoid hammering IPC on fast output
  let dataBuffer = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  ptyProcess.onData((data: string) => {
    if (shuttingDown) return
    countTerminalData(data.length)
    const state = idleState.get(id)
    if (state) {
      state.lastOutputAt = Date.now()
    }
    // Log to disk for session restore
    const logger = getOrCreateLogger(id)
    logger.append(data)

    // If this terminal is being transferred, buffer instead of forwarding
    const transferState = transferStates.get(id)
    if (transferState) {
      const chunk = Buffer.from(data)
      transferState.buffer.push(chunk)
      transferState.bufferSize += chunk.length
      // Evict oldest chunks if over cap
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
            try {
              sendToWindow(windowId, TERMINAL_DATA, id, dataBuffer)
            } catch {
              // Window destroyed between buffer and flush
            }
          }
        }
        dataBuffer = ''
      }, 16)
    }
  })

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (shuttingDown) return
    const windowId = terminalOwners.get(id)
    terminals.delete(id)
    terminalPids.delete(id)
    terminalOwners.delete(id)
    idleState.delete(id)
    if (windowId != null) {
      sendToWindow(windowId, TERMINAL_EXIT, id, exitCode)
    }
  })
}

function writeTerminal(id: string, data: string): void {
  const pty = terminals.get(id)
  if (pty) {
    // If suspended, resume first — otherwise the write would queue but the
    // shell wouldn't run until the next SIGCONT.
    const state = idleState.get(id)
    if (state?.suspended) resumeTerminal(id)
    try {
      pty.write(data)
    } catch {
      // PTY fd already closed (race between shell exit and incoming write)
    }
  }
}

function resizeTerminal(id: string, cols: number, rows: number): void {
  const pty = terminals.get(id)
  if (pty) {
    const state = idleState.get(id)
    if (state?.suspended) resumeTerminal(id)
    pty.resize(cols, rows)
  }
}

function killTerminal(id: string): void {
  const logger = getOrCreateLogger(id)
  logger.flush()
  removeLogger(id)  // flush + stop timer + remove from map (keeps files)

  // If the PTY is suspended, SIGTERM would queue until SIGCONT — resume first
  // so the process actually receives the signal and exits.
  const state = idleState.get(id)
  if (state?.suspended) resumeTerminal(id)

  // Kill the entire process group so child processes (dev servers, watchers,
  // etc.) don't survive as zombies keeping ports open.
  const pid = terminalPids.get(id)
  if (pid) {
    try { process.kill(-pid, 'SIGTERM') } catch { /* process group may be gone */ }
  }
  const pty = terminals.get(id)
  if (pty) {
    pty.kill()
    terminals.delete(id)
    terminalPids.delete(id)
    terminalOwners.delete(id)
    idleState.delete(id)
  }
}

function getTerminalPid(id: string): number | undefined {
  return terminalPids.get(id)
}

export function registerHandlers(): void {
  ipcMain.handle(
    TERMINAL_CREATE,
    async (
      event,
      options: { cols: number; rows: number; cwd?: string; shell?: string },
    ): Promise<string> => {
      const id = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      // Validate + auto-fallback so a stale/invalid `defaultShellPath` doesn't
      // make every terminal die with `execvp(3) failed.: No such file or
      // directory` (see GitHub issue #2).
      const resolved = resolveShell(options.shell)

      let cwd: string
      if (options.cwd) {
        cwd = validateCwd(options.cwd)
      } else {
        cwd = os.homedir()
      }
      const win = windowFromEvent(event)
      const windowId = win?.id ?? -1
      createTerminal(id, resolved, cwd, options.cols, options.rows, {}, windowId)
      return id
    },
  )

  ipcMain.handle(TERMINAL_WRITE, async (_event, terminalId: string, data: string) => {
    writeTerminal(terminalId, data)
  })

  ipcMain.handle(
    TERMINAL_RESIZE,
    async (_event, terminalId: string, cols: number, rows: number) => {
      resizeTerminal(terminalId, cols, rows)
    },
  )

  ipcMain.handle(TERMINAL_KILL, async (_event, terminalId: string) => {
    killTerminal(terminalId)
  })

  ipcMain.handle(TERMINAL_SET_VISIBILITY, async (_event, terminalId: string, visible: boolean) => {
    setTerminalVisibility(terminalId, visible)
  })

  // Get terminal's current working directory via lsof
  ipcMain.handle(TERMINAL_GET_CWD, async (_event, ptyId: string): Promise<string | null> => {
    const pid = terminalPids.get(ptyId)
    if (!pid) return null
    return new Promise((resolve) => {
      // `-a` ANDs the filters; without it lsof ORs `-d cwd` with `-p <pid>` and
      // returns the cwd of every process on the system (we'd parse the wrong one).
      execFile('lsof', ['-a', '-d', 'cwd', '-p', `${pid}`, '-Fn'], {
        encoding: 'utf-8',
        timeout: 2000,
      }, (err, stdout) => {
        if (err || !stdout) {
          resolve(null)
          return
        }
        const lines = stdout.split('\n')
        const nameLine = lines.find(l => l.startsWith('n'))
        resolve(nameLine ? nameLine.slice(1) : null)
      })
    })
  })

  // Read terminal scrollback for session restore — prefers .scrollback (plain text
  // captured from xterm buffer) over .log (raw PTY output with escape sequences)
  ipcMain.handle(TERMINAL_LOG_READ, async (_event, terminalId: string): Promise<string | null> => {
    const { TerminalLogger } = await import('./terminalLogger')
    const logDir = TerminalLogger.getLogDir()

    // Prefer scrollback capture (clean plain text)
    const scrollbackPath = path.join(logDir, `${terminalId}.scrollback`)
    try {
      const data = fs.readFileSync(scrollbackPath, 'utf-8')
      if (data) return data
    } catch { /* fall through to raw log */ }

    // Fall back to raw PTY log — use the existing logger if one is active,
    // otherwise read log files directly to avoid leaking a TerminalLogger
    // instance (each one starts a setInterval that never gets cleaned up).
    const existing = getOrCreateLogger(terminalId)
    // If this terminal has an active PTY, a logger already existed — safe to use.
    // If the PTY is gone, we just created a new logger; read then clean it up.
    const data = existing.readAll()
    if (!terminals.has(terminalId)) {
      removeLogger(terminalId)
    }
    return data || null
  })

  // Save terminal scrollback content (plain text from xterm buffer)
  ipcMain.handle(TERMINAL_SCROLLBACK_SAVE, async (_event, ptyId: string, content: string): Promise<void> => {
    const { TerminalLogger } = await import('./terminalLogger')
    const logDir = TerminalLogger.getLogDir()
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true })
    }
    fs.writeFileSync(path.join(logDir, `${ptyId}.scrollback`), content, 'utf-8')
  })

}

/**
 * Kill all active PTY processes. Called on app quit to avoid node-pty's
 * ThreadSafeFunction firing into a torn-down JS environment (which aborts
 * the process via Napi::Error::ThrowAsJavaScriptException during
 * Environment::CleanupHandles).
 */
export function killAllTerminals(): void {
  shuttingDown = true
  if (idleScanner) {
    clearInterval(idleScanner)
    idleScanner = null
  }
  // Dispose all terminal loggers (flush + stop timers + clear map)
  disposeAllLoggers()

  // Snapshot pids so the SIGKILL pass below sees the same set even if
  // entries are removed concurrently.
  const pids: number[] = []
  for (const [id] of terminals) {
    const pid = terminalPids.get(id)
    if (pid) pids.push(pid)
  }

  // Resume any suspended PTYs first so SIGTERM is actually delivered (otherwise
  // it would queue behind the SIGSTOP until SIGCONT).
  for (const pid of pids) {
    try { process.kill(-pid, 'SIGCONT') } catch { /* gone */ }
  }

  // Phase 4.2: issue SIGTERM to every process group in parallel — gives child
  // processes (dev servers, watchers) a chance to clean up before we escalate.
  for (const pid of pids) {
    try { process.kill(-pid, 'SIGTERM') } catch { /* gone */ }
  }

  // After 150 ms, send SIGKILL to any survivors. We do NOT await waitpid —
  // the main process will exit immediately after this function returns and
  // the OS will reap any orphans. Intentionally do not call pty.kill() (see
  // historical note: ThreadSafeFunction → SIGABRT during cleanup).
  setTimeout(() => {
    for (const pid of pids) {
      try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
    }
  }, 150)

  terminals.clear()
  terminalPids.clear()
  terminalOwners.clear()
  idleState.clear()
}

export { getTerminalPid, flushAllLoggers }
