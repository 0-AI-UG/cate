// =============================================================================
// Shell / Process Monitor IPC handlers
// Ported from ProcessMonitor.swift — walks process tree to detect Claude Code
// =============================================================================

import { execFile } from 'child_process'
import { ipcMain, BrowserWindow } from 'electron'
import {
  SHELL_WHICH,
  SHELL_REGISTER_TERMINAL,
  SHELL_UNREGISTER_TERMINAL,
  SHELL_ACTIVITY_UPDATE,
  SHELL_PORTS_UPDATE,
  SHELL_CWD_UPDATE,
} from '../../shared/ipc-channels'
import { terminalPids } from './terminal'
import type { TerminalActivity, ClaudeCodeState } from '../../shared/types'

interface TerminalRegistration {
  shellPid: number
  workspaceId: string
  nodeId: string
}

interface PreviousState {
  claudeState: ClaudeCodeState
  previouslyHadClaude: boolean
}

interface ScanResult {
  terminalActivity: TerminalActivity
  claudeState: ClaudeCodeState
  previouslyHadClaude: boolean
}

// Registered terminals for process monitoring
const registeredTerminals: Map<string, TerminalRegistration> = new Map()

// Track previous state for transition detection
const previousStates: Map<string, PreviousState> = new Map()

// Polling interval handle
let pollInterval: ReturnType<typeof setInterval> | null = null

// Busy flag to prevent overlapping poll cycles
let pollBusy = false

/**
 * Get direct child PIDs of a given process.
 * Runs: ps -o pid= -ppid=<pid>
 */
function getChildPids(pid: number): Promise<number[]> {
  if (!pid || pid <= 0) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=', `-ppid=${pid}`], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve([])
        return
      }
      resolve(
        stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => parseInt(line, 10))
          .filter((n) => !isNaN(n))
      )
    })
  })
}

/**
 * Get the process name (command basename) for a given PID.
 * Runs: ps -o comm= -p <pid>
 */
function getProcessName(pid: number): Promise<string | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'comm=', '-p', `${pid}`], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }
      const name = stdout.trim()
      if (name.length === 0) {
        resolve(null)
        return
      }
      // ps -o comm= may return full path; extract basename
      const parts = name.split('/')
      resolve(parts[parts.length - 1])
    })
  })
}

/**
 * Check if a process name looks like Claude Code.
 * Matches: 'claude', 'claude-code', or starts with 'claude'.
 */
function isClaudeProcess(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === 'claude' || lower === 'claude-code' || lower.startsWith('claude')
}

/**
 * Check if a process name is a common shell.
 */
function isShellProcess(name: string): boolean {
  const shells = ['zsh', 'bash', 'fish', 'sh', 'tcsh', 'ksh', 'dash']
  return shells.includes(name.toLowerCase())
}

async function getAllDescendantPids(pid: number): Promise<number[]> {
  const children = await getChildPids(pid)
  const allDescendants = [...children]
  for (const child of children) {
    allDescendants.push(...(await getAllDescendantPids(child)))
  }
  return allDescendants
}

async function scanListeningPorts(): Promise<Map<string, number[]>> {
  if (registeredTerminals.size === 0) {
    return new Map()
  }

  const pidToTerminal = new Map<number, string>()
  const pidPromises: Promise<void>[] = []
  for (const [terminalId, info] of registeredTerminals) {
    pidPromises.push(
      getAllDescendantPids(info.shellPid).then((descendants) => {
        const allPids = [info.shellPid, ...descendants]
        for (const pid of allPids) {
          pidToTerminal.set(pid, terminalId)
        }
      })
    )
  }
  await Promise.all(pidPromises)

  return new Promise((resolve) => {
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pn'], {
      timeout: 5000,
    }, (err, stdout) => {
      const result = new Map<string, number[]>()
      if (err || !stdout) {
        resolve(result)
        return
      }

      let currentPid: number | null = null
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = parseInt(line.slice(1), 10)
        } else if (line.startsWith('n') && currentPid != null) {
          const terminalId = pidToTerminal.get(currentPid)
          if (terminalId) {
            const match = line.match(/:(\d+)$/)
            if (match) {
              const port = parseInt(match[1], 10)
              if (!result.has(terminalId)) {
                result.set(terminalId, [])
              }
              const ports = result.get(terminalId)!
              if (!ports.includes(port)) {
                ports.push(port)
              }
            }
          }
        }
      }

      resolve(result)
    })
  })
}

function getProcessCwd(pid: number): Promise<string | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('lsof', ['-p', `${pid}`, '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      timeout: 2000,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve(null)
        return
      }
      for (const line of stdout.split('\n')) {
        if (line.startsWith('n') && line.length > 1) {
          resolve(line.slice(1))
          return
        }
      }
      resolve(null)
    })
  })
}

/**
 * Scan a single terminal's process tree to detect activity and Claude state.
 * Ported from ProcessMonitor.scanProcesses(for:) in Swift.
 */
async function scanTerminal(terminalId: string, info: TerminalRegistration): Promise<ScanResult> {
  const prev = previousStates.get(terminalId) || {
    claudeState: 'notRunning' as ClaudeCodeState,
    previouslyHadClaude: false,
  }

  // Get children of the shell PID
  const childrenToScan = await getChildPids(info.shellPid)

  let foundClaude = false
  let claudeHasActiveChildren = false
  let firstChildName: string | null = null

  for (const childPid of childrenToScan) {
    const name = await getProcessName(childPid)
    if (name) {
      if (firstChildName === null && !isShellProcess(name)) {
        firstChildName = name
      }
      if (isClaudeProcess(name)) {
        foundClaude = true
        const claudeChildren = await getChildPids(childPid)
        if (claudeChildren.length > 0) {
          claudeHasActiveChildren = true
        }
      }
    }
  }

  // Determine terminal activity
  const terminalActivity: TerminalActivity =
    firstChildName != null
      ? { type: 'running', processName: firstChildName }
      : { type: 'idle' }

  // Determine Claude state
  let claudeState: ClaudeCodeState = prev.claudeState
  let previouslyHadClaude = prev.previouslyHadClaude

  if (foundClaude) {
    if (claudeHasActiveChildren) {
      claudeState = 'running'
    } else {
      claudeState = 'waitingForInput'
    }
    previouslyHadClaude = true
  } else if (previouslyHadClaude) {
    claudeState = 'finished'
    previouslyHadClaude = false
  }

  return { terminalActivity, claudeState, previouslyHadClaude }
}

/**
 * Start polling all registered terminals every 2 seconds.
 * Emits SHELL_ACTIVITY_UPDATE IPC events when state changes.
 */
function startPolling(mainWindow: BrowserWindow): void {
  if (pollInterval) return

  pollInterval = setInterval(async () => {
    if (mainWindow.isDestroyed()) {
      stopPolling()
      return
    }

    if (pollBusy) return
    pollBusy = true

    try {
      // Scan all terminals concurrently
      const entries = Array.from(registeredTerminals.entries())
      const scanResults = await Promise.all(
        entries.map(async ([terminalId, info]) => {
          const result = await scanTerminal(terminalId, info)
          return { terminalId, result }
        })
      )

      for (const { terminalId, result } of scanResults) {
        // Update previous state
        previousStates.set(terminalId, {
          claudeState: result.claudeState,
          previouslyHadClaude: result.previouslyHadClaude,
        })

        // Auto-clear finished state after detecting it
        if (result.claudeState === 'finished') {
          setTimeout(() => {
            const current = previousStates.get(terminalId)
            if (current && current.claudeState === 'finished') {
              previousStates.set(terminalId, {
                claudeState: 'notRunning',
                previouslyHadClaude: false,
              })
            }
          }, 5000)
        }

        // Send activity update to renderer
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            SHELL_ACTIVITY_UPDATE,
            terminalId,
            result.terminalActivity,
            result.claudeState,
          )
        }
      }

      // --- CWD updates (concurrent) ---
      const cwdResults = await Promise.all(
        entries.map(async ([terminalId, info]) => {
          const cwd = await getProcessCwd(info.shellPid)
          return { terminalId, cwd }
        })
      )

      for (const { terminalId, cwd } of cwdResults) {
        if (cwd && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(SHELL_CWD_UPDATE, terminalId, cwd)
        }
      }

      // --- Port scan (async, non-blocking) ---
      const portMap = await scanListeningPorts()
      if (!mainWindow.isDestroyed()) {
        for (const [terminalId, ports] of portMap) {
          mainWindow.webContents.send(SHELL_PORTS_UPDATE, terminalId, ports.sort((a, b) => a - b))
        }
        for (const terminalId of registeredTerminals.keys()) {
          if (!portMap.has(terminalId)) {
            mainWindow.webContents.send(SHELL_PORTS_UPDATE, terminalId, [])
          }
        }
      }
    } finally {
      pollBusy = false
    }
  }, 2000)
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

export function registerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(
    SHELL_REGISTER_TERMINAL,
    async (_event, terminalId: string, pid?: number) => {
      // Look up the shell PID from the terminal module if not provided
      const shellPid = pid ?? terminalPids.get(terminalId)
      if (shellPid == null) {
        console.warn(`[shell] No PID found for terminal ${terminalId}`)
        return
      }

      registeredTerminals.set(terminalId, {
        shellPid,
        workspaceId: '',
        nodeId: '',
      })

      previousStates.set(terminalId, {
        claudeState: 'notRunning',
        previouslyHadClaude: false,
      })

      // Start polling on first registration
      startPolling(mainWindow)
    },
  )

  ipcMain.handle(SHELL_UNREGISTER_TERMINAL, async (_event, terminalId: string) => {
    registeredTerminals.delete(terminalId)
    previousStates.delete(terminalId)
  })

  ipcMain.handle(SHELL_WHICH, async (_event, command: string): Promise<string | null> => {
    return new Promise((resolve) => {
      execFile('which', [command], (err, stdout) => {
        if (err) {
          resolve(null)
        } else {
          resolve(stdout.trim() || null)
        }
      })
    })
  })

  // Start polling only when first terminal is registered (not immediately)
  // Polling will be started on first register call
}
