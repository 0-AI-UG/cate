// =============================================================================
// Shell / Process Monitor IPC handlers
// Walks process tree to detect agent CLIs (Claude, Codex, etc.)
// =============================================================================

import { execFile } from 'child_process'
import { app, BrowserWindow, ipcMain } from 'electron'
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
import { countSpawn } from '../perf/perfMonitor'
import type { TerminalActivity } from '../../shared/types'

interface TerminalRegistration {
  shellPid: number
  workspaceId: string
  nodeId: string
  ownerWindowId: number
}

interface PreviousState {
  /** Last agent name seen — carried across transient scan misses so the tab
   *  name doesn't flicker when a single `ps` cycle fails to spot the agent. */
  previousAgentName: string | null
}

interface ScanResult {
  terminalActivity: TerminalActivity
  agentName: string | null
  agentPresent: boolean
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

// Fast poll (1s): process-tree scan for agent detection — drives the activity
// indicators and the agent "needs input" / "finished" notifications, so it
// must stay responsive.
const ACTIVITY_POLL_MS = 1000
let pollInterval: ReturnType<typeof setInterval> | null = null
let pollBusy = false

// Slow poll (5s): the heavier lsof scans (listening ports + cwd). These don't
// need 1s freshness — ports/cwd rarely change second-to-second — so they ride a
// slower timer to cut the sustained process-spawn load.
const SLOW_POLL_MS = 5000
let slowPollInterval: ReturnType<typeof setInterval> | null = null
let slowPollBusy = false

// True iff at least one app window is currently focused. The cwd scan (purely
// cosmetic — only consumed on demand by "Copy Working Directory") is skipped
// entirely while the app is unfocused.
let anyWindowFocused = true
let focusHooksInstalled = false

function refreshFocusState(): boolean {
  anyWindowFocused = BrowserWindow.getAllWindows().some(
    (w) => !w.isDestroyed() && w.isFocused(),
  )
  return anyWindowFocused
}

function installFocusHooks(): void {
  if (focusHooksInstalled) return
  focusHooksInstalled = true
  refreshFocusState()
  app.on('browser-window-focus', () => { anyWindowFocused = true })
  // browser-window-blur fires before focus transfers between this app's own
  // windows, so re-derive truth from the window list rather than trusting the
  // single event.
  app.on('browser-window-blur', () => { refreshFocusState() })
}

/**
 * Get direct child PIDs of a given process.
 * Runs: ps -o pid= -ppid=<pid>
 */
function getChildPids(pid: number): Promise<number[]> {
  if (!pid || pid <= 0) return Promise.resolve([])
  return limit(() => new Promise((resolve) => {
    countSpawn('pgrep')
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
    countSpawn('ps')
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
    // Antigravity's interactive terminal CLI installs as the `agy` binary —
    // `antigravity` is the GUI IDE (runs as an Electron process), never a
    // terminal child, so it would never match here.
    displayName: 'Antigravity',
    match: (n) => n === 'agy',
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
    // @earendil-works/pi-coding-agent — runs as the `pi` binary (sets its own
    // process title to `pi`).
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

  const pids = Array.from(pidToTerminal.keys())
  if (pids.length === 0) return new Map()

  return limit(() => new Promise((resolve) => {
    // `-a` ANDs the network filter with `-p <pids>`, so lsof inspects ONLY the
    // terminals' process trees instead of enumerating every socket on the
    // system. Without `-a`, lsof ORs the filters and scans all processes.
    countSpawn('lsof:ports')
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-a', '-p', pids.join(','), '-F', 'pn'], {
      timeout: 5000,
    }, (err, stdout) => {
      const result = new Map<string, number[]>()
      // Parse whatever lsof produced regardless of exit status: when some of
      // the requested pids have no listening sockets, lsof exits 1 but still
      // emits valid records for the pids that do. Only bail if there's no output.
      if (!stdout) {
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
    // `-a` ANDs the filters; without it lsof ORs `-p <pid>` with `-d cwd` and
    // scans every process on the system (then we'd parse the first match, which
    // is invariably some low-pid daemon sitting at "/").
    countSpawn('lsof:cwd')
    execFile('lsof', ['-a', '-p', `${pid}`, '-d', 'cwd', '-Fn'], {
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
async function scanTerminal(
  terminalId: string,
  info: TerminalRegistration,
): Promise<ScanResult> {
  const prev = previousStates.get(terminalId) || { previousAgentName: null }

  const childrenToScan = await getChildPids(info.shellPid)

  let foundAgentName: string | null = null
  let firstChildName: string | null = null

  for (const childPid of childrenToScan) {
    const name = await getProcessName(childPid)
    if (name) {
      if (firstChildName === null && !isShellProcess(name)) {
        firstChildName = name
      }
      if (!foundAgentName) {
        const agentMatch = matchAgentProcess(name)
        if (agentMatch) foundAgentName = agentMatch
      }
    }
  }

  const agentPresent = foundAgentName != null

  const terminalActivity: TerminalActivity =
    firstChildName != null
      ? { type: 'running', processName: firstChildName }
      : { type: 'idle' }

  const agentName = foundAgentName ?? prev.previousAgentName

  return {
    terminalActivity,
    agentName,
    agentPresent,
  }
}

/**
 * Fast scan (every ACTIVITY_POLL_MS): walk each terminal's process tree to
 * detect agent activity. Emits SHELL_ACTIVITY_UPDATE to the owning window.
 */
async function runActivityScan(): Promise<void> {
  if (pollBusy) return
  pollBusy = true
  try {
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
      previousStates.set(terminalId, { previousAgentName: result.agentName })

      sendToWindow(
        info.ownerWindowId,
        SHELL_ACTIVITY_UPDATE,
        terminalId,
        result.terminalActivity,
        result.agentName,
        result.agentPresent,
      )
    }
  } finally {
    pollBusy = false
  }
}

/**
 * Slow scan (every SLOW_POLL_MS): the heavier lsof work. Listening ports and
 * cwd change rarely, so they don't belong on the 1s loop. The cwd scan is
 * skipped entirely while the app is unfocused (it only backs an on-demand
 * "Copy Working Directory" action).
 */
async function runSlowScan(): Promise<void> {
  if (slowPollBusy) return
  slowPollBusy = true
  try {
    const entries = Array.from(registeredTerminals.entries())
    if (entries.length === 0) return

    // --- CWD updates (concurrent) — focus-gated ---
    if (anyWindowFocused) {
      const cwdResults = await Promise.all(
        entries.map(async ([terminalId, info]) => {
          try {
            const cwd = await getProcessCwd(info.shellPid)
            return { terminalId, info, cwd }
          } catch {
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
    }

    // --- Port scan (scoped to terminal pids; see scanListeningPorts). Not
    //     focus-gated: it's cheap now and still surfaces ports for dev servers
    //     that come up while the app is backgrounded. ---
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
    slowPollBusy = false
  }
}

/** Start both poll timers (called on first terminal registration). */
function startPolling(): void {
  if (pollInterval) return
  pollInterval = setInterval(() => { void runActivityScan() }, ACTIVITY_POLL_MS)
  slowPollInterval = setInterval(() => { void runSlowScan() }, SLOW_POLL_MS)
}

function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  if (slowPollInterval) {
    clearInterval(slowPollInterval)
    slowPollInterval = null
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
  installFocusHooks()

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

      previousStates.set(terminalId, { previousAgentName: null })

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
