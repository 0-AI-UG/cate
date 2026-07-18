// =============================================================================
// Process capability — electron-free node-pty wrapper. Owns the PTY map keyed by
// id and streams output via the create-time callbacks; it has NO knowledge of
// windows, buffering, transfer, idle-suspend, or logging — those stay in the
// terminal.ts session layer (electron) which forwards to the owning window.
//
// Shell resolution + env are injected so the SAME code runs locally (Electron's
// resolveShell + login-shell env) and inside the daemon (the remote host's
// shell + env). lsof-based cwd resolution is POSIX-only (null elsewhere).
// =============================================================================

import type { IPty } from 'node-pty'
import os from 'os'
import { execFile } from 'child_process'
import type { ProcessHost, PtyCreateOptions, PtyHandle, PtyActivity } from '../../main/runtime/types'
import type { TerminalActivity, TerminalAgentSession } from '../../shared/types'
import { matchAgentDef, matchAgentProcess } from '../../shared/agents'
import { catePathEnv } from '../cateCli'
import { probeSessionForAgent, startTimeForPid } from './agentSessions'
import {
  type ProcTree,
  snapshotProcessTreeProc,
  getCwdProc,
  listeningPortsByPidProc,
} from './procfs'

// ---------------------------------------------------------------------------
// Process-monitor helpers (POSIX). Ported verbatim from the old shell.ts local
// monitor so a LOCAL runtime derives byte-identical activity/ports; a remote
// runtime runs the same scans on the daemon host (`ps`/`lsof` are POSIX there).
//
// On Linux these scans read /proc directly instead of forking ps/lsof — forking
// ~1.6×/sec stalls the Electron main event loop and lags renderer IPC (#246).
// macOS keeps the ps/lsof path; /proc is Linux-only. See procfs.ts.
// ---------------------------------------------------------------------------

const isLinux = process.platform === 'linux'

/** ONE `ps` snapshot of the whole process table, indexed for tree walks. */
function snapshotProcessTreePs(): Promise<ProcTree> {
  return new Promise((resolve) => {
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
        // "<pid> <ppid> <comm>" — comm may contain spaces (keep remainder) and
        // can be a full path on macOS, so take the basename.
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
  })
}

/** Process-table snapshot: /proc on Linux (no fork — #246), `ps` elsewhere. */
function snapshotProcessTree(): Promise<ProcTree> {
  return isLinux ? snapshotProcessTreeProc() : snapshotProcessTreePs()
}

/** A process's cwd. Linux: readlink /proc/<pid>/cwd (no fork — #246). macOS:
 *  lsof. win32: null. */
function cwdForPid(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  if (isLinux) return getCwdProc(pid)
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-p', `${pid}`, '-Fn'], { encoding: 'utf-8', timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) { return resolve(null) }
      const nameLine = stdout.split('\n').find((l) => l.startsWith('n'))
      resolve(nameLine ? nameLine.slice(1) : null)
    })
  })
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

// Agent detection list lives in src/shared/agents.ts (one place, shared with the
// renderer's logo map) — matchAgentProcess maps a child process name to its
// display name.

function isShellProcess(name: string): boolean {
  const shells = ['zsh', 'bash', 'fish', 'sh', 'tcsh', 'ksh', 'dash']
  return shells.includes(name.toLowerCase())
}

/** Derive one pty's activity + agent detection from its direct children. */
function activityForPid(shellPid: number, tree: ProcTree): PtyActivity {
  const childrenToScan = tree.childrenByPid.get(shellPid) ?? []
  let foundAgentName: string | null = null
  let firstChildName: string | null = null
  for (const childPid of childrenToScan) {
    const name = tree.nameByPid.get(childPid)
    if (!name) continue
    if (firstChildName === null && !isShellProcess(name)) firstChildName = name
    if (!foundAgentName) {
      const agentMatch = matchAgentProcess(name)
      if (agentMatch) foundAgentName = agentMatch
    }
  }
  const activity: TerminalActivity =
    firstChildName != null ? { type: 'running', processName: firstChildName } : { type: 'idle' }
  return { activity, agentName: foundAgentName, agentPresent: foundAgentName != null }
}

// node-pty is loaded LAZILY so the daemon still starts (and serves files/git)
// on a host where the native PTY binary isn't available (e.g. a Linux server
// with no node-pty prebuild) — only terminal creation fails there, with a clear
// error, instead of the whole daemon crashing on import.
type PtySpawn = typeof import('node-pty').spawn
let cachedSpawn: PtySpawn | null = null
async function getPtySpawn(): Promise<PtySpawn> {
  if (cachedSpawn) return cachedSpawn
  try {
    const mod = await import('node-pty')
    cachedSpawn = mod.spawn
    return cachedSpawn
  } catch (err) {
    throw new Error(
      `Terminals are unavailable on this host: failed to load node-pty (${err instanceof Error ? err.message : String(err)}). ` +
        'A platform-matched node-pty native binary must be staged for this target.',
    )
  }
}

export interface ResolvedProcessShell {
  path: string
  args: string[]
  /** Optional notice to surface in the terminal (shell fallback, etc.). */
  notice?: string
}

export interface ProcessDeps {
  resolveShell: (requested?: string) => ResolvedProcessShell
  getEnv: () => Record<string, string>
  /**
   * Idle-suspend (POSIX-only): SIGSTOP a pty that's offscreen and silent past
   * the threshold, SIGCONT on input/visibility. OFF by default — remote daemons
   * don't pass it. The daemon hosting the LOCAL workspace passes it so
   * backgrounded local terminals still suspend.
   */
  idleSuspend?: boolean
}

/** The capability the daemon holds onto: the ProcessHost plus the concrete
 *  surface the daemon entry needs (group-kill of every live pty's process tree
 *  on shutdown), which isn't part of the portable ProcessHost interface. */
export interface ProcessCapability extends ProcessHost {
  /** SIGKILL every live pty's process GROUP synchronously (daemon shutdown), so
   *  quitting the app (which kills the local daemon) doesn't orphan dev servers. */
  killAllGroups(): void
  /** Enable/disable idle-suspend at runtime (mirrors the autoSuspendIdleTerminals
   *  setting). Enabling on a POSIX host starts the scanner; disabling stops it and
   *  SIGCONT-resumes any currently-suspended ptys so none are left frozen. win32 is
   *  a no-op (idle-suspend is POSIX-only). */
  setIdleSuspend(enabled: boolean): void
}

interface IdleState {
  lastOutputAt: number
  visible: boolean
  suspended: boolean
}

const IDLE_SUSPEND_MS = 2 * 60_000
const IDLE_CHECK_INTERVAL_MS = 20_000

export function createProcessCapability(deps: ProcessDeps): ProcessCapability {
  const ptys = new Map<string, IPty>()
  let seq = 0

  // Idle-suspend state (only populated when idleEnabled && POSIX). Tracks per-pty
  // last output, visibility, and whether we've SIGSTOP'd it. `idleEnabled` is
  // mutable so the setting can be toggled live (setIdleSuspend); always false on
  // win32 (idle-suspend is POSIX-only).
  let idleEnabled = deps.idleSuspend === true && process.platform !== 'win32'
  const idle = new Map<string, IdleState>()
  let scanner: ReturnType<typeof setInterval> | null = null

  const suspend = (id: string): void => {
    const pid = ptys.get(id)?.pid
    const state = idle.get(id)
    if (!pid || !state || state.suspended) return
    try { process.kill(-pid, 'SIGSTOP') } catch { /* gone */ }
    state.suspended = true
  }

  const resume = (id: string): void => {
    const pid = ptys.get(id)?.pid
    const state = idle.get(id)
    if (!pid || !state || !state.suspended) return
    try { process.kill(-pid, 'SIGCONT') } catch { /* gone */ }
    state.suspended = false
    state.lastOutputAt = Date.now()
  }

  const scan = (): void => {
    const now = Date.now()
    for (const [id, state] of idle) {
      if (state.visible || state.suspended) continue
      if (now - state.lastOutputAt < IDLE_SUSPEND_MS) continue
      suspend(id)
    }
  }

  const ensureScanner = (): void => {
    if (!idleEnabled || scanner) return
    scanner = setInterval(scan, IDLE_CHECK_INTERVAL_MS)
  }

  const stopScanner = (): void => {
    if (scanner) { clearInterval(scanner); scanner = null }
  }

  return {
    async create(
      opts: PtyCreateOptions,
      onData: (id: string, data: string) => void,
      onExit: (id: string, exitCode: number) => void,
    ): Promise<PtyHandle> {
      const id = opts.id ?? `pty-${Date.now()}-${Math.round(seq++ + Math.random() * 1e6).toString(36)}`
      const ptySpawn = await getPtySpawn()
      const shell = deps.resolveShell(opts.shell)
      const pty = ptySpawn(shell.path, shell.args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        // Empty cwd → the host's home dir (resolved on whichever host this
        // capability runs on: the local machine or the remote daemon).
        cwd: opts.cwd || os.homedir(),
        // Merge caller env over the host env; when a CLI endpoint was injected
        // (CATE_API), also put the bundled `cate` on PATH so agents can run it.
        env: catePathEnv({ ...deps.getEnv(), ...(opts.env ?? {}) }),
      })
      ptys.set(id, pty)
      if (idleEnabled) {
        idle.set(id, { lastOutputAt: Date.now(), visible: true, suspended: false })
        ensureScanner()
      }
      pty.onData((data) => {
        const state = idle.get(id)
        if (state) state.lastOutputAt = Date.now()
        onData(id, data)
      })
      pty.onExit(({ exitCode }) => {
        ptys.delete(id)
        idle.delete(id)
        onExit(id, exitCode)
      })
      return { id, pid: pty.pid, notice: shell.notice, shell: shell.path }
    },

    write(id: string, data: string): void {
      const pty = ptys.get(id)
      if (!pty) return
      if (idle.get(id)?.suspended) resume(id)
      try { pty.write(data) } catch { /* fd closed between exit and write */ }
    },

    resize(id: string, cols: number, rows: number): void {
      try { ptys.get(id)?.resize(cols, rows) } catch { /* pty gone */ }
    },

    kill(id: string): void {
      const pty = ptys.get(id)
      if (!pty) return
      if (idle.get(id)?.suspended) resume(id)
      // Kill the whole process GROUP so children (dev servers) don't linger,
      // then still call node-pty's own kill. POSIX-only (negative-pid group
      // signalling); on win32 keep node-pty's plain kill. Killing an already-
      // gone group is a caught no-op, so this stays idempotent.
      if (process.platform !== 'win32') {
        try { process.kill(-pty.pid, 'SIGTERM') } catch { /* group already gone */ }
      }
      try { pty.kill() } catch { /* already dead */ }
      ptys.delete(id)
      idle.delete(id)
    },

    async getCwd(id: string): Promise<string | null> {
      const pty = ptys.get(id)
      if (!pty) return null
      return cwdForPid(pty.pid)
    },

    setVisibility(id: string, visible: boolean): void {
      // With idle-suspend off this stays a no-op (the in-process local host runs
      // its OWN idle-suspend layer). On: track visibility + SIGCONT-resume a
      // suspended pty as it becomes visible again.
      const state = idle.get(id)
      if (!state) return
      state.visible = visible
      if (visible && state.suspended) resume(id)
    },

    async scanActivity(ids: string[]): Promise<Record<string, PtyActivity>> {
      const owned = ids
        // A suspended pty's process tree is frozen (SIGSTOP) — skip it so we
        // don't scan a stale snapshot of a stopped tree.
        .filter((id) => idle.get(id)?.suspended !== true)
        .map((id) => ({ id, pid: ptys.get(id)?.pid }))
        .filter((e): e is { id: string; pid: number } => e.pid != null)
      if (owned.length === 0 || process.platform === 'win32') return {}
      const tree = await snapshotProcessTree()
      const out: Record<string, PtyActivity> = {}
      for (const { id, pid } of owned) out[id] = activityForPid(pid, tree)
      return out
    },

    async probeAgentSession(id: string): Promise<TerminalAgentSession | null> {
      const pty = ptys.get(id)
      if (!pty || process.platform === 'win32') return null
      // Same direct-children detection as activityForPid, but resolving the
      // AgentDef (its id keys the session-store adapter).
      const tree = await snapshotProcessTree()
      let agentPid: number | null = null
      let agentId: string | null = null
      for (const childPid of tree.childrenByPid.get(pty.pid) ?? []) {
        const name = tree.nameByPid.get(childPid)
        const def = name ? matchAgentDef(name) : null
        if (def) {
          agentPid = childPid
          agentId = def.id
          break
        }
      }
      if (agentPid == null || agentId == null) return null
      // The AGENT process's cwd is the session join key (the CLIs record the
      // cwd they were launched in); fall back to the shell's cwd — while the
      // agent runs in the foreground the two can only differ for a subshell
      // launch like `(cd sub && claude)`. Its start time gates the store scan:
      // sessions are persisted lazily, so without the gate a fresh agent would
      // probe to the PREVIOUS session in the same cwd.
      const [agentCwd, agentStartMs] = await Promise.all([cwdForPid(agentPid), startTimeForPid(agentPid)])
      const cwd = agentCwd ?? (await cwdForPid(pty.pid))
      if (!cwd) return null
      const sessionId = await probeSessionForAgent({ agentId, agentPid, cwd, agentStartMs })
      return sessionId ? { agentId, sessionId, cwd } : null
    },

    async scanPorts(ids: string[]): Promise<Record<string, number[]>> {
      const owned = ids
        .map((id) => ({ id, pid: ptys.get(id)?.pid }))
        .filter((e): e is { id: string; pid: number } => e.pid != null)
      if (owned.length === 0 || process.platform === 'win32') return {}
      const tree = await snapshotProcessTree()

      // Map every pid in each pty's subtree back to its pty id.
      const pidToPty = new Map<number, string>()
      for (const { id, pid } of owned) {
        pidToPty.set(pid, id)
        for (const child of descendantsOf(pid, tree)) pidToPty.set(child, id)
      }
      const pids = Array.from(pidToPty.keys())
      if (pids.length === 0) return {}

      // Linux: cross /proc/net/tcp{,6} with each pid's socket fds (no fork — #246).
      if (isLinux) {
        const byPid = await listeningPortsByPidProc(pids)
        const result: Record<string, number[]> = {}
        for (const [pid, ports] of byPid) {
          const id = pidToPty.get(pid)
          if (!id) continue
          const acc = result[id] ?? (result[id] = [])
          for (const port of ports) if (!acc.includes(port)) acc.push(port)
        }
        return result
      }

      return new Promise((resolve) => {
        // `-a` ANDs the network filter with `-p <pids>` so lsof inspects ONLY
        // these process trees (without it lsof ORs the filters → whole system).
        execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-a', '-p', pids.join(','), '-F', 'pn'], {
          timeout: 5000,
        }, (err, stdout) => {
          const result: Record<string, number[]> = {}
          // Parse regardless of exit status: lsof exits 1 when some requested
          // pids have no listeners but still emits records for those that do.
          if (!stdout) { resolve(result); return }
          let currentPid: number | null = null
          for (const line of stdout.split('\n')) {
            if (line.startsWith('p')) {
              currentPid = parseInt(line.slice(1), 10)
            } else if (line.startsWith('n') && currentPid != null) {
              const id = pidToPty.get(currentPid)
              if (!id) continue
              const match = line.match(/:(\d+)$/)
              if (!match) continue
              const port = parseInt(match[1], 10)
              const ports = result[id] ?? (result[id] = [])
              if (!ports.includes(port)) ports.push(port)
            }
          }
          resolve(result)
        })
      })
    },

    setIdleSuspend(enabled: boolean): void {
      // POSIX-only; win32 stays a no-op (idleEnabled is already false there).
      if (process.platform === 'win32') return
      if (enabled === idleEnabled) return
      idleEnabled = enabled
      if (enabled) {
        // Start tracking every live pty (none have idle state if we were off at
        // create time), then start the scanner.
        const now = Date.now()
        for (const id of ptys.keys()) {
          if (!idle.has(id)) idle.set(id, { lastOutputAt: now, visible: true, suspended: false })
        }
        ensureScanner()
      } else {
        // Stop the scanner and SIGCONT-resume anything we'd suspended, so no pty
        // is left frozen, then drop the tracking state entirely.
        stopScanner()
        for (const id of [...idle.keys()]) resume(id)
        idle.clear()
      }
    },

    killAllGroups(): void {
      stopScanner()
      if (process.platform === 'win32') {
        for (const pty of ptys.values()) { try { pty.kill() } catch { /* gone */ } }
        ptys.clear()
        idle.clear()
        return
      }
      // SIGKILL each live pty's whole process group so dev-server children die
      // with the daemon. SIGCONT first so a SIGSTOP-suspended group can receive
      // the kill (a stopped process won't act on a pending SIGKILL until resumed).
      for (const pty of ptys.values()) {
        try { process.kill(-pty.pid, 'SIGCONT') } catch { /* gone */ }
        try { process.kill(-pty.pid, 'SIGKILL') } catch { /* already gone */ }
      }
      ptys.clear()
      idle.clear()
    },
  }
}
