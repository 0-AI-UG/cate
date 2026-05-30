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
import { terminalPids, isTerminalSuspended } from './terminal'
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

// Fast poll: process-tree scan for agent detection — drives the activity
// indicators and the agent "needs input" / "finished" notifications. It stays
// at 1s while a window is focused so the UI feels live, but backs off to 5s
// when the whole app is unfocused: the activity indicators aren't visible then,
// and agent "needs input" detection is driven by PTY title/spinner events in
// the renderer (event-based, not this scan), so a few extra seconds of presence
// latency costs nothing while the spawn rate — the real background-CPU/battery
// drain — drops ~5×. (Each cycle forks one `ps` snapshot regardless of terminal
// count; see snapshotProcessTree.)
const ACTIVITY_POLL_FOCUSED_MS = 1000
const ACTIVITY_POLL_UNFOCUSED_MS = 5000
let pollInterval: ReturnType<typeof setInterval> | null = null
let pollBusy = false

// Slow poll: the heavier lsof scans (listening ports + cwd). Ports/cwd rarely
// change second-to-second, so this rides a 5s timer while focused and backs off
// to 15s while unfocused (lsof is the priciest spawn we make).
const SLOW_POLL_FOCUSED_MS = 5000
const SLOW_POLL_UNFOCUSED_MS = 15000
let slowPollInterval: ReturnType<typeof setInterval> | null = null
let slowPollBusy = false

// Cadence the timers are currently running at, so applyPollCadence() can skip a
// needless clear/re-arm when focus flips but the resulting cadence is unchanged.
let activeActivityMs = 0
let activeSlowMs = 0

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
  app.on('browser-window-focus', () => {
    const wasFocused = anyWindowFocused
    anyWindowFocused = true
    if (!wasFocused) {
      // Returning to the app — restore the fast cadence and take an immediate
      // scan so the activity indicators refresh without waiting out the timer.
      applyPollCadence()
      void runActivityScan()
    }
  })
  // browser-window-blur fires before focus transfers between this app's own
  // windows, so re-derive truth from the window list rather than trusting the
  // single event.
  app.on('browser-window-blur', () => {
    const stillFocused = refreshFocusState()
    if (!stillFocused) applyPollCadence()
  })
}

// One process-table snapshot, indexed for tree walks. Built once per scan
// cycle and shared across every registered terminal.
interface ProcTree {
  /** comm basename, keyed by pid. */
  nameByPid: Map<number, string>
  /** direct child pids, keyed by parent pid. */
  childrenByPid: Map<number, number[]>
}

/**
 * Take ONE `ps` snapshot of the whole process table and index it for tree
 * walks. This replaces the old per-PID fan-out — one `pgrep -P` per terminal
 * plus one `ps -o comm=` per child plus recursive `pgrep` for descendants —
 * with a single spawn per scan cycle, regardless of how many terminals are
 * open. Same data (child names + descendant trees), O(1) spawns instead of
 * O(total PIDs), which is the dominant idle-time process-spawn cost.
 */
function snapshotProcessTree(): Promise<ProcTree> {
  return limit(() => new Promise((resolve) => {
    countSpawn('ps:tree')
    execFile('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf-8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ nameByPid: new Map(), childrenByPid: new Map() })
        return
      }
      const nameByPid = new Map<number, string>()
      const childrenByPid = new Map<number, number[]>()
      for (const line of stdout.split('\n')) {
        // "<pid> <ppid> <comm>" — comm may contain spaces, so keep it as the
        // remainder. comm can be a full path on macOS; take the basename to
        // match the old `ps -o comm=` + basename behaviour exactly.
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/)
        if (!m) continue
        const pid = parseInt(m[1], 10)
        const ppid = parseInt(m[2], 10)
        if (isNaN(pid) || isNaN(ppid)) continue
        nameByPid.set(pid, m[3].split('/').pop() ?? m[3])
        const siblings = childrenByPid.get(ppid)
        if (siblings) siblings.push(pid)
        else childrenByPid.set(ppid, [pid])
      }
      resolve({ nameByPid, childrenByPid })
    })
  }))
}

/** All descendant pids of `pid` (BFS over the snapshot), excluding `pid`. */
function descendantsOf(pid: number, tree: ProcTree): number[] {
  const out: number[] = []
  const stack = [...(tree.childrenByPid.get(pid) ?? [])]
  while (stack.length > 0) {
    const p = stack.pop()!
    out.push(p)
    const kids = tree.childrenByPid.get(p)
    if (kids) stack.push(...kids)
  }
  return out
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

async function scanListeningPorts(tree: ProcTree): Promise<Map<string, number[]>> {
  if (registeredTerminals.size === 0) {
    return new Map()
  }

  // Map every pid in each terminal's process tree back to its terminal, read
  // synchronously from the shared snapshot (no per-pid spawns).
  const pidToTerminal = new Map<number, string>()
  for (const [terminalId, info] of registeredTerminals) {
    pidToTerminal.set(info.shellPid, terminalId)
    for (const pid of descendantsOf(info.shellPid, tree)) {
      pidToTerminal.set(pid, terminalId)
    }
  }

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
 * Reads from the shared per-cycle process snapshot — no per-PID spawns.
 * Ported from ProcessMonitor.scanProcesses(for:) in Swift.
 */
function scanTerminal(
  terminalId: string,
  info: TerminalRegistration,
  tree: ProcTree,
): ScanResult {
  const prev = previousStates.get(terminalId) || { previousAgentName: null }

  const childrenToScan = tree.childrenByPid.get(info.shellPid) ?? []

  let foundAgentName: string | null = null
  let firstChildName: string | null = null

  for (const childPid of childrenToScan) {
    const name = tree.nameByPid.get(childPid)
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
 * Fast scan (1s focused / 5s unfocused): walk each terminal's process tree to
 * detect agent activity. Emits SHELL_ACTIVITY_UPDATE to the owning window.
 */
async function runActivityScan(): Promise<void> {
  if (pollBusy) return
  pollBusy = true
  try {
    const entries = Array.from(registeredTerminals.entries())
    if (entries.length === 0) return

    // One snapshot for the whole cycle (see snapshotProcessTree).
    const tree = await snapshotProcessTree()

    for (const [terminalId, info] of entries) {
      // A SIGSTOP-suspended terminal's process tree is frozen — it can't change
      // state until resumed (which forces a fresh scan), so scanning it would
      // just re-derive the same result. Skip the work.
      if (isTerminalSuspended(terminalId)) continue

      const result = scanTerminal(terminalId, info, tree)
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
 * Slow scan (5s focused / 15s unfocused): the heavier lsof work. Listening ports and
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
    //     that come up while the app is backgrounded. One ps snapshot feeds the
    //     descendant walk; lsof then inspects only those pids. ---
    const tree = await snapshotProcessTree()
    const portMap = await scanListeningPorts(tree)
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

/**
 * (Re)arm both poll timers at the cadence matching the current focus state.
 * Called on first terminal registration and whenever app focus flips. No-op
 * when no terminals are registered, and a no-op when the cadence is already
 * correct (so a focus flip between this app's own windows doesn't churn timers).
 */
function applyPollCadence(): void {
  if (registeredTerminals.size === 0) return
  const activityMs = anyWindowFocused ? ACTIVITY_POLL_FOCUSED_MS : ACTIVITY_POLL_UNFOCUSED_MS
  const slowMs = anyWindowFocused ? SLOW_POLL_FOCUSED_MS : SLOW_POLL_UNFOCUSED_MS
  if (pollInterval && slowPollInterval && activeActivityMs === activityMs && activeSlowMs === slowMs) {
    return
  }
  if (pollInterval) clearInterval(pollInterval)
  if (slowPollInterval) clearInterval(slowPollInterval)
  activeActivityMs = activityMs
  activeSlowMs = slowMs
  pollInterval = setInterval(() => { void runActivityScan() }, activityMs)
  slowPollInterval = setInterval(() => { void runSlowScan() }, slowMs)
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
  activeActivityMs = 0
  activeSlowMs = 0
}

/**
 * Unregister all terminals owned by a specific window (called on window close).
 */
export function unregisterTerminalsForWindow(windowId: number): void {
  for (const [terminalId, info] of registeredTerminals) {
    if (info.ownerWindowId === windowId) {
      registeredTerminals.delete(terminalId)
      previousStates.delete(terminalId)
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

      // Start (or re-confirm) polling on first registration, at the cadence
      // matching the current focus state.
      applyPollCadence()
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
    if (registeredTerminals.size === 0) {
      stopPolling()
    }
  })

}
