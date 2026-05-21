// =============================================================================
// Shell / Process Monitor IPC handlers
// Walks process tree to detect agent CLIs (Claude, Aider, Codex, Gemini, etc.)
// =============================================================================

import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import log from '../logger'
import {
  SHELL_REGISTER_TERMINAL,
  SHELL_UNREGISTER_TERMINAL,
  SHELL_ACTIVITY_UPDATE,
  SHELL_PORTS_UPDATE,
  SHELL_CWD_UPDATE,
  SHELL_AGENT_SCREEN_STATE,
} from '../../shared/ipc-channels'
import { terminalPids } from './terminal'
import { sendToWindow, windowFromEvent, broadcastToAll } from '../windowRegistry'
import { getShellEnv } from '../shellEnv'
import type { TerminalActivity, AgentState } from '../../shared/types'

interface TerminalRegistration {
  shellPid: number
  workspaceId: string
  nodeId: string
  ownerWindowId: number
}

interface PreviousState {
  agentState: AgentState
  previousAgentName: string | null
  previouslyHadAgent: boolean
}

interface ScanResult {
  terminalActivity: TerminalActivity
  agentState: AgentState
  agentName: string | null
  previouslyHadAgent: boolean
  /** True if the agent has a non-helper subprocess actively running. */
  subprocessActive: boolean
}

// Concurrency limiter — caps simultaneous execFile calls across all terminals
function createLimit(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const next = () => { active--; const fn = queue.shift(); if (fn) { active++; fn() } }
  return <T>(fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const run = () => fn().then(v => { next(); resolve(v) }, e => { next(); reject(e) })
    if (active < max) { active++; run() } else queue.push(run)
  })
}
const limit = createLimit(4)

// Registered terminals for process monitoring
const registeredTerminals: Map<string, TerminalRegistration> = new Map()

// Track previous state for transition detection
const previousStates: Map<string, PreviousState> = new Map()

// Backoff: terminals that failed last cycle are skipped once
const skipNextScan: Set<string> = new Set()

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
  return limit(() => new Promise((resolve) => {
    execFile('pgrep', ['-P', `${pid}`], {
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
  }))
}

/**
 * Get the process name (command basename) for a given PID.
 * Runs: ps -o comm= -p <pid>
 */
function getProcessName(pid: number): Promise<string | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  return limit(() => new Promise((resolve) => {
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
  }))
}

/**
 * Agent CLI definitions. Each entry maps process name patterns to a display name.
 * The matcher checks if the process basename (lowercased) matches any pattern.
 */
const AGENT_DEFINITIONS: { displayName: string; match: (name: string) => boolean }[] = [
  {
    displayName: 'Claude Code',
    match: (n) => n === 'claude' || n === 'claude-code' || n.startsWith('claude'),
  },
  {
    displayName: 'Codex',
    match: (n) => n === 'codex',
  },
  {
    displayName: 'Gemini CLI',
    match: (n) => n === 'gemini',
  },
  {
    displayName: 'Cursor',
    match: (n) => n === 'cursor' || n === 'cursor-agent',
  },
  {
    displayName: 'OpenCode',
    match: (n) => n === 'opencode',
  },
  {
    // @mariozechner/pi-coding-agent — installs as the `pi` binary.
    displayName: 'PI Agent',
    match: (n) => n === 'pi',
  },
]

/**
 * Check if a process name matches a known agent CLI.
 * Returns the display name if matched, or null if not an agent.
 */
function matchAgentProcess(name: string): string | null {
  const lower = name.toLowerCase()
  for (const agent of AGENT_DEFINITIONS) {
    if (agent.match(lower)) return agent.displayName
  }
  return null
}

/**
 * Check if a process name is a common shell.
 */
function isShellProcess(name: string): boolean {
  const shells = ['zsh', 'bash', 'fish', 'sh', 'tcsh', 'ksh', 'dash']
  return shells.includes(name.toLowerCase())
}

/**
 * Agent helpers that linger between turns and must not be treated as work.
 * Claude Code keeps `caffeinate` and a persistent tool shell alive after the
 * first turn; counting them as "active" would pin the indicator to "running"
 * forever.
 */
const IDLE_AGENT_HELPERS = new Set(['caffeinate', 'pmset'])

/**
 * True if the agent has a child process that's *actually doing something* —
 * a non-helper, non-idle-shell descendant. Used as a "definitely running"
 * signal that overrides the renderer's buffer-stability reading.
 */
async function agentIsActive(agentPid: number): Promise<boolean> {
  const children = await getChildPids(agentPid)
  for (const childPid of children) {
    const name = await getProcessName(childPid)
    if (!name) continue
    const lower = name.toLowerCase()
    if (IDLE_AGENT_HELPERS.has(lower)) continue
    if (isShellProcess(lower)) {
      const subchildren = await getChildPids(childPid)
      if (subchildren.length > 0) return true
      continue
    }
    return true
  }
  return false
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

  return limit(() => new Promise((resolve) => {
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
  }))
}

function getProcessCwd(pid: number): Promise<string | null> {
  if (!pid || pid <= 0) return Promise.resolve(null)
  return limit(() => new Promise((resolve) => {
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
  }))
}

/**
 * Scan a single terminal's process tree to detect activity and Claude state.
 * Ported from ProcessMonitor.scanProcesses(for:) in Swift.
 */
async function scanTerminal(terminalId: string, info: TerminalRegistration): Promise<ScanResult> {
  const prev = previousStates.get(terminalId) || {
    agentState: 'notRunning' as AgentState,
    previousAgentName: null,
    previouslyHadAgent: false,
  }

  // Get children of the shell PID
  const childrenToScan = await getChildPids(info.shellPid)

  let foundAgentName: string | null = null
  let foundAgentPid: number | null = null
  let firstChildName: string | null = null

  for (const childPid of childrenToScan) {
    const name = await getProcessName(childPid)
    if (name) {
      if (firstChildName === null && !isShellProcess(name)) {
        firstChildName = name
      }
      if (!foundAgentName) {
        const agentMatch = matchAgentProcess(name)
        if (agentMatch) {
          foundAgentName = agentMatch
          foundAgentPid = childPid
        }
      }
    }
  }

  // Probe for an actively-working subprocess only when we have an agent, so
  // we don't pay the extra ps/pgrep round-trips for plain shells.
  const subprocessActive = foundAgentPid != null ? await agentIsActive(foundAgentPid) : false

  // Determine terminal activity
  const terminalActivity: TerminalActivity =
    firstChildName != null
      ? { type: 'running', processName: firstChildName }
      : { type: 'idle' }

  // Determine agent state
  let agentState: AgentState = prev.agentState
  let agentName: string | null = foundAgentName ?? prev.previousAgentName
  let previouslyHadAgent = prev.previouslyHadAgent

  if (foundAgentName) {
    // Two-tier detection:
    //   1. If the agent has an active non-helper subprocess (a tool command
    //      really executing), it's unambiguously running — emit that and
    //      override whatever screen-state was previously reported.
    //   2. Otherwise, defer to whatever the renderer's screen detector last
    //      reported (it writes into previousStates via the screen-state IPC).
    //      Default to 'running' on the very first scan, before any report
    //      has arrived.
    if (subprocessActive) {
      agentState = 'running'
    } else {
      agentState = prev.agentState === 'notRunning' || prev.agentState === 'finished'
        ? 'running'
        : prev.agentState
    }
    previouslyHadAgent = true
  } else if (previouslyHadAgent) {
    agentState = 'finished'
    previouslyHadAgent = false
  }

  return { terminalActivity, agentState, agentName, previouslyHadAgent, subprocessActive }
}

/**
 * Start polling all registered terminals every 2 seconds.
 * Emits SHELL_ACTIVITY_UPDATE IPC events to the owning window.
 */
function startPolling(): void {
  if (pollInterval) return

  pollInterval = setInterval(async () => {
    if (pollBusy) return
    pollBusy = true

    try {
      // Scan all terminals concurrently
      const entries = Array.from(registeredTerminals.entries())
      if (entries.length === 0) return
      const scanResults = await Promise.all(
        entries.map(async ([terminalId, info]) => {
          if (skipNextScan.has(terminalId)) {
            skipNextScan.delete(terminalId)
            return null
          }
          try {
            const result = await scanTerminal(terminalId, info)
            return { terminalId, info, result }
          } catch (e) {
            skipNextScan.add(terminalId)
            return null
          }
        })
      )

      for (const entry of scanResults) {
        if (!entry) continue
        const { terminalId, info, result } = entry
        // Update previous state
        previousStates.set(terminalId, {
          agentState: result.agentState,
          previousAgentName: result.agentName,
          previouslyHadAgent: result.previouslyHadAgent,
        })

        // Auto-clear finished state after detecting it
        if (result.agentState === 'finished') {
          setTimeout(() => {
            const current = previousStates.get(terminalId)
            if (current && current.agentState === 'finished') {
              previousStates.set(terminalId, {
                agentState: 'notRunning',
                previousAgentName: null,
                previouslyHadAgent: false,
              })
            }
          }, 5000)
        }

        // Send activity update to the owning window
        sendToWindow(
          info.ownerWindowId,
          SHELL_ACTIVITY_UPDATE,
          terminalId,
          result.terminalActivity,
          result.agentState,
          result.agentName,
          result.subprocessActive,
        )
      }

      // --- CWD updates (concurrent) ---
      const cwdResults = await Promise.all(
        entries.map(async ([terminalId, info]) => {
          if (skipNextScan.has(terminalId)) return null
          try {
            const cwd = await getProcessCwd(info.shellPid)
            return { terminalId, info, cwd }
          } catch {
            skipNextScan.add(terminalId)
            return null
          }
        })
      )

      for (const cwdEntry of cwdResults) {
        if (!cwdEntry) continue
        const { terminalId, info, cwd } = cwdEntry
        if (cwd) {
          sendToWindow(info.ownerWindowId, SHELL_CWD_UPDATE, terminalId, cwd)
        }
      }

      // --- Port scan (async, non-blocking) ---
      const portMap = await scanListeningPorts()
      for (const [terminalId, ports] of portMap) {
        const info = registeredTerminals.get(terminalId)
        if (info) {
          sendToWindow(info.ownerWindowId, SHELL_PORTS_UPDATE, terminalId, ports.sort((a, b) => a - b))
        }
      }
      for (const [terminalId, info] of registeredTerminals) {
        if (!portMap.has(terminalId)) {
          sendToWindow(info.ownerWindowId, SHELL_PORTS_UPDATE, terminalId, [])
        }
      }
    } finally {
      pollBusy = false
    }
  }, 1000)
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

/**
 * Unregister all terminals owned by a specific window (called on window close).
 */
export function unregisterTerminalsForWindow(windowId: number): void {
  for (const [terminalId, info] of registeredTerminals) {
    if (info.ownerWindowId === windowId) {
      registeredTerminals.delete(terminalId)
      previousStates.delete(terminalId)
      skipNextScan.delete(terminalId)
    }
  }
  if (registeredTerminals.size === 0) {
    stopPolling()
  }
}

export function registerHandlers(): void {
  ipcMain.handle(
    SHELL_REGISTER_TERMINAL,
    async (event, terminalId: string, pid?: number) => {
      // Look up the shell PID from the terminal module if not provided
      const shellPid = pid ?? terminalPids.get(terminalId)
      if (shellPid == null) {
        log.warn(`[shell] No PID found for terminal ${terminalId}`)
        return
      }

      const win = windowFromEvent(event)
      const ownerWindowId = win?.id ?? -1

      registeredTerminals.set(terminalId, {
        shellPid,
        workspaceId: '',
        nodeId: '',
        ownerWindowId,
      })

      previousStates.set(terminalId, {
        agentState: 'notRunning',
        previousAgentName: null,
        previouslyHadAgent: false,
      })

      // Start polling on first registration
      startPolling()
    },
  )

  // Renderer reports screen-derived agent state; rebroadcast so every
  // window's sidebar gets it (the sidebar in the main window won't otherwise
  // see state for terminals that live in a detached panel window). Also
  // record it in previousStates so the next process-tree scan doesn't clobber
  // the renderer's reading by re-emitting 'running'.
  ipcMain.on(SHELL_AGENT_SCREEN_STATE, (_event, terminalId: string, state: string) => {
    const prev = previousStates.get(terminalId)
    if (prev) {
      previousStates.set(terminalId, { ...prev, agentState: state as AgentState })
    }
    broadcastToAll(SHELL_AGENT_SCREEN_STATE, terminalId, state)
  })

  ipcMain.handle(SHELL_UNREGISTER_TERMINAL, async (_event, terminalId: string) => {
    registeredTerminals.delete(terminalId)
    previousStates.delete(terminalId)
    skipNextScan.delete(terminalId)
    if (registeredTerminals.size === 0) {
      stopPolling()
    }
  })

}
