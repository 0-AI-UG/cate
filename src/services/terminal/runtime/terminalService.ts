// The terminal service: PTYs in the runtime, each with a headless screen that
// any number of viewers attach to. Output fans out to every viewer as a flow
// controlled byte stream; input from any viewer goes to the same PTY; the PTY
// fits the viewer that last asked (`view` with `fit`; the first viewer until
// then), and every viewer is told its size and whether it fits. Activity,
// ports and cwd are scanned here and published as statuses. Everything that
// runs a process asks `trust.requireTrusted()` first (9.2).

import { randomUUID } from 'node:crypto'
import { RpcError } from '@kernel/rpc/contract'
import type { Logger } from '@kernel/log/contract'
import type { SliceValues } from '@kernel/settings/contract'
import type {
  AttachEnd,
  AttachParams,
  AttachEvent,
  LaunchIntent,
  ReadResult,
  ScreenSnapshot,
  SpawnParams,
  SpawnResult,
  TerminalActivity,
  TerminalStatus,
  TerminalStatusChange,
  TerminalStatuses,
  ViewParams,
  terminalSettings,
} from '../contract'
import type {
  ActivityObserver,
  EnvContributor,
  ExitObserver,
  InputObserver,
  LaunchPlan,
  LaunchResolver,
  OutputObserver,
  SpawnInfo,
} from './extensions'
import { HeadlessScreen } from './headlessScreen'
import { activityForPid, countingScanner, systemScanner, type ProcessScanner } from './procScan'
import { resolveShell as resolveHostShell } from './shellResolver'
import { sanitizeEnv } from './loginEnv'
import { TerminalLog, isSafeLogKey, readSavedScreen, removeLogFiles } from './terminalLog'

// ---- Ports ------------------------------------------------------------------

/** The part of node-pty's IPty the service uses. */

/** How long shells get to end their jobs on shutdown before SIGKILL. */
const SHUTDOWN_GRACE_MS = 1_000
/** The exit code observers get for a terminal closed or never spawned. */
const CLOSED_EXIT_CODE = -1

export interface PtyProcess {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  pause(): void
  resume(): void
}

export type PtySpawner = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyProcess | Promise<PtyProcess>

export type TerminalSettingValues = SliceValues<(typeof terminalSettings)['keys']>

export interface TerminalSettingsReader {
  getAll(): TerminalSettingValues
  subscribe(listener: (values: TerminalSettingValues) => void): () => void
}

export interface ResolvedShell {
  path: string
  args: string[]
  /** Shown in the terminal (a fallback shell was used). */
  notice?: string
}

export interface TerminalServiceDeps {
  /** Canonical workspace root, the default cwd. */
  root: string
  /** `dataPaths(dataDir).terminalLogs`. */
  logDir: string
  trust: { isTrusted(): boolean; requireTrusted(): void }
  settings: TerminalSettingsReader
  log: Logger
  /** The base env of every PTY (the daemon's login env). */
  env: () => Record<string, string | undefined>
  /** Validates a requested cwd against the workspace path scope; returns the
   *  path to use or throws. */
  resolveCwd?: (cwd: string) => string | Promise<string>
  spawnPty?: PtySpawner
  resolveShell?: (requested?: string) => ResolvedShell
  scanner?: ProcessScanner
  /** Someone is looking (a client with a viewer has the person's attention).
   *  Without attention, scans run at the unwatched cadence. Default: always. */
  attended?: () => boolean
  /** Counts work toward the runtime's perf counters (`activityScan`,
   *  `spawnPs`, `spawnLsof`). */
  countPerf?: (name: string) => void
  /** Signals a PTY's process group (POSIX). */
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void
}

/** Where attach output goes; a kernel/rpc StreamSink fits. */
export interface ViewerSink {
  emit(event: AttachEvent): void
  /** False once the viewer is more than its window behind. */
  bytes(chunk: Uint8Array): boolean
  drain(): Promise<void>
  onInput(listener: (bytes: Uint8Array) => void): void
  end(result: AttachEnd): void
}

export interface TerminalService {
  spawn(params: SpawnParams): Promise<SpawnResult>
  write(id: string, data: string): void
  view(params: ViewParams): void
  /** Returns the detach function. */
  attach(params: AttachParams, sink: ViewerSink): () => void
  kill(id: string): void
  close(id: string): void
  cwd(id: string): Promise<string | null>
  read(id: string, lines?: number): Promise<ReadResult>
  snapshot(id: string): Promise<ScreenSnapshot>
  list(): TerminalStatus[]
  statuses(): TerminalStatuses
  onStatusChange(listener: (change: TerminalStatusChange) => void): () => void
  /** A live terminal with a foreground program other than its shell. */
  busy(): boolean
  /** Runs the activity, ports and cwd scans now. */
  scan(): Promise<void>

  registerEnvContributor(contributor: EnvContributor): () => void
  registerLaunchIntent(kind: string, resolver: LaunchResolver): () => void
  onOutput(observer: OutputObserver): () => void
  onInput(observer: InputObserver): () => void
  onExit(observer: ExitObserver): () => void
  onActivity(observer: ActivityObserver): () => void

  /** Daemon shutdown: saves every screen, hangs up every shell (its jobs
   *  too), then kills what is left. */
  shutdown(): Promise<void>
}

// ---- Implementation -----------------------------------------------------------

const IDLE_SUSPEND_MS = 2 * 60_000
const IDLE_CHECK_MS = 20_000
/** A viewer that stays behind this long is dropped and re-attaches. */
const VIEWER_LAG_MS = 5_000
/** Pause the PTY while the headless screen has this much unparsed. */
const SCREEN_BACKLOG_HIGH = 4 * 1024 * 1024
const RESTORED_MARKER = '\r\n\x1b[90m--- restored session ---\x1b[0m\r\n'

interface Viewer {
  id: string
  sink: ViewerSink
  cols?: number
  rows?: number
  visible: boolean
  lastFit: number
  /** The last `size` event sent, so each change is sent once. */
  told: string
  decoder: TextDecoder
  lagTimer: ReturnType<typeof setTimeout> | null
}

interface Term {
  id: string
  panelId: string | null
  pid: number
  shell: string
  pty: PtyProcess
  alive: boolean
  exitCode: number | null
  screen: HeadlessScreen
  log: TerminalLog | null
  viewers: Map<string, Viewer>
  fittedViewer: string | null
  activity: TerminalActivity
  ports: number[]
  cwd: string | null
  lastOutputAt: number
  suspended: boolean
  pauses: Set<string>
  lastStatus: string
}

let loadedSpawn: PtySpawner | null = null

/** node-pty loads lazily, so a host without its native binary still serves
 *  files and git; only spawning a terminal fails. */
export async function nodePtySpawn(...args: Parameters<PtySpawner>): Promise<PtyProcess> {
  if (!loadedSpawn) {
    try {
      const mod = await import('node-pty')
      loadedSpawn = mod.spawn as unknown as PtySpawner
    } catch (err) {
      throw new Error(`Terminals are unavailable on this host: failed to load node-pty (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  return loadedSpawn(...args)
}

function defaultResolveShell(requested?: string): ResolvedShell {
  const resolved = resolveHostShell(requested)
  const notice = resolved.fallback && requested ? `Shell "${requested}" unavailable; using ${resolved.path}\r\n` : undefined
  return { path: resolved.path, args: [], ...(notice ? { notice } : {}) }
}

function defaultSignalGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return
  try { process.kill(-pid, signal) } catch { /* group gone */ }
}

const encoder = new TextEncoder()

function gone(id: string): RpcError {
  return new RpcError('gone', `No terminal ${id}`)
}

function validSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2000
}

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const spawnPty = deps.spawnPty ?? nodePtySpawn
  const resolveShell = deps.resolveShell ?? defaultResolveShell
  const baseScanner = deps.scanner ?? systemScanner
  const scanner = deps.countPerf ? countingScanner(baseScanner, deps.countPerf) : baseScanner
  const attended = deps.attended ?? (() => true)
  const signalGroup = deps.signalGroup ?? defaultSignalGroup
  const log = deps.log

  const terms = new Map<string, Term>()
  const envContributors = new Set<EnvContributor>()
  const launchResolvers = new Map<string, LaunchResolver>([
    ['command', (params) => ({ command: params as LaunchPlan['command'] })],
    ['input', (params) => ({ input: (params as { text: string }).text })],
  ])
  const outputObservers = new Set<OutputObserver>()
  const inputObservers = new Set<InputObserver>()
  const exitObservers = new Set<ExitObserver>()
  const activityObservers = new Set<ActivityObserver>()
  const statusListeners = new Set<(change: TerminalStatusChange) => void>()
  let viewerSeq = 0

  let settings = deps.settings.getAll()
  const stopSettings = deps.settings.subscribe((next) => {
    const before = settings
    settings = next
    if (next.terminalScrollback !== before.terminalScrollback) {
      for (const term of terms.values()) term.screen.setScrollback(next.terminalScrollback)
    }
    if (next.autoSuspendIdleTerminals !== before.autoSuspendIdleTerminals) {
      if (!idleSuspendOn()) for (const term of terms.values()) resume(term)
      syncTimers()
    }
  })

  const idleSuspendOn = (): boolean => settings.autoSuspendIdleTerminals && process.platform !== 'win32'

  const notify = <A extends unknown[]>(set: Set<(...args: A) => void>, ...args: A): void => {
    for (const fn of set) {
      try { fn(...args) } catch (err) { log.warn('terminal observer failed: %O', err) }
    }
  }

  // ---- Status ---------------------------------------------------------------

  const statusOf = (term: Term): TerminalStatus => ({
    id: term.id,
    panelId: term.panelId,
    pid: term.pid,
    shell: term.shell,
    alive: term.alive,
    exitCode: term.exitCode,
    activity: term.activity,
    ports: term.ports,
    cwd: term.cwd,
    suspended: term.suspended,
    viewers: term.viewers.size,
  })

  const emitStatus = (change: TerminalStatusChange): void => notify(statusListeners, change)

  const touch = (term: Term): void => {
    if (terms.get(term.id) !== term) return
    const status = statusOf(term)
    const key = JSON.stringify(status)
    if (key === term.lastStatus) return
    term.lastStatus = key
    emitStatus({ [term.id]: status })
  }

  // ---- Flow control and size ---------------------------------------------------

  const setPaused = (term: Term, reason: string, paused: boolean): void => {
    const before = term.pauses.size > 0
    if (paused) term.pauses.add(reason)
    else term.pauses.delete(reason)
    const after = term.pauses.size > 0
    if (before === after || !term.alive) return
    try {
      if (after) term.pty.pause()
      else term.pty.resume()
    } catch { /* pty gone */ }
  }

  const applySize = (term: Term): void => {
    const viewer = term.fittedViewer ? term.viewers.get(term.fittedViewer) : undefined
    if (!viewer || !validSize(viewer.cols) || !validSize(viewer.rows)) return
    const { cols, rows } = viewer
    if (cols === term.screen.cols && rows === term.screen.rows) return
    term.screen.resize(cols, rows)
    if (term.alive) {
      try { term.pty.resize(cols, rows) } catch { /* pty gone */ }
    }
  }

  /** Tells every viewer the PTY's size and whether the PTY fits it. */
  const tellSize = (term: Term): void => {
    const { cols, rows } = term.screen
    for (const v of term.viewers.values()) {
      const fitted = term.fittedViewer === v.id
      const told = `${cols}x${rows}:${fitted}`
      if (v.told === told) continue
      v.told = told
      v.sink.emit({ kind: 'size', cols, rows, fitted })
    }
  }

  const fitTo = (term: Term, viewer: Viewer): void => {
    viewer.lastFit = Date.now()
    term.fittedViewer = viewer.id
    applySize(term)
    tellSize(term)
  }

  const dropViewer = (term: Term, viewer: Viewer): void => {
    if (term.viewers.get(viewer.id) !== viewer) return
    term.viewers.delete(viewer.id)
    if (viewer.lagTimer) clearTimeout(viewer.lagTimer)
    setPaused(term, `viewer:${viewer.id}`, false)
    if (term.fittedViewer === viewer.id) {
      let next: Viewer | undefined
      for (const v of term.viewers.values()) if (!next || v.lastFit > next.lastFit) next = v
      term.fittedViewer = next?.id ?? null
      applySize(term)
      tellSize(term)
    }
    syncTimers()
    touch(term)
  }

  const sendTo = (term: Term, viewer: Viewer, chunk: Uint8Array): void => {
    if (viewer.sink.bytes(chunk) || viewer.lagTimer) return
    // Behind: hold the PTY until this viewer catches up, or drop it.
    setPaused(term, `viewer:${viewer.id}`, true)
    viewer.lagTimer = setTimeout(() => {
      viewer.lagTimer = null
      if (term.viewers.get(viewer.id) !== viewer) return
      dropViewer(term, viewer)
      viewer.sink.end({ reason: 'lagged' })
    }, VIEWER_LAG_MS)
    void viewer.sink.drain().then(() => {
      if (viewer.lagTimer) clearTimeout(viewer.lagTimer)
      viewer.lagTimer = null
      setPaused(term, `viewer:${viewer.id}`, false)
    })
  }

  /** Output from the PTY, or text the service shows (a notice, a restore). */
  const output = (term: Term, data: string, fromPty: boolean): void => {
    if (fromPty) {
      term.lastOutputAt = Date.now()
      ioSinceScan = true
    }
    term.screen.write(data)
    term.log?.append(data)
    if (term.viewers.size > 0) {
      const chunk = encoder.encode(data)
      for (const viewer of [...term.viewers.values()]) sendTo(term, viewer, chunk)
    }
    if (term.screen.backlog > SCREEN_BACKLOG_HIGH && !term.pauses.has('screen')) {
      setPaused(term, 'screen', true)
      void term.screen.settled().then(() => setPaused(term, 'screen', false))
    }
    if (fromPty) notify(outputObservers, term.id, data)
  }

  // ---- Idle suspend ---------------------------------------------------------------

  const visible = (term: Term): boolean => {
    for (const viewer of term.viewers.values()) if (viewer.visible) return true
    return false
  }

  const resume = (term: Term): void => {
    if (!term.suspended) return
    signalGroup(term.pid, 'SIGCONT')
    term.suspended = false
    term.lastOutputAt = Date.now()
    touch(term)
  }

  const checkIdle = (): void => {
    if (!idleSuspendOn()) return
    const now = Date.now()
    for (const term of terms.values()) {
      if (!term.alive || term.suspended || visible(term) || now - term.lastOutputAt < IDLE_SUSPEND_MS) continue
      signalGroup(term.pid, 'SIGSTOP')
      term.suspended = true
      touch(term)
    }
  }

  // ---- Scans ------------------------------------------------------------------------

  let scanTimer: ReturnType<typeof setInterval> | null = null
  let idleTimer: ReturnType<typeof setInterval> | null = null
  let ticks = 0
  let scanning = false
  /** A terminal read or wrote since the last scan: its foreground program may have changed. */
  let ioSinceScan = true

  const liveTerms = (): Term[] => [...terms.values()].filter((t) => t.alive)

  const scanActivity = async (withCwd: boolean, withPorts: boolean): Promise<void> => {
    const live = liveTerms().filter((t) => !t.suspended)
    if (live.length === 0) return
    deps.countPerf?.('activityScan')
    ioSinceScan = false
    const tree = await scanner.tree()
    for (const term of live) {
      if (!term.alive) continue
      term.activity = activityForPid(term.pid, tree)
      notify(activityObservers, { terminalId: term.id, panelId: term.panelId, pid: term.pid, activity: term.activity, tree })
    }
    if (withPorts) {
      const byPid = await scanner.ports(live.map((t) => t.pid), tree)
      for (const term of live) term.ports = (byPid.get(term.pid) ?? []).slice().sort((a, b) => a - b)
    }
    if (withCwd && scanner.cwds) {
      const byPid = await scanner.cwds(live.map((t) => t.pid)).catch(() => new Map<number, string>())
      for (const term of live) {
        const cwd = byPid.get(term.pid)
        if (cwd) term.cwd = cwd
      }
    } else if (withCwd) {
      await Promise.all(live.map(async (term) => {
        const cwd = await scanner.cwd(term.pid).catch(() => null)
        if (cwd) term.cwd = cwd
      }))
    }
    for (const term of live) touch(term)
  }

  const runScan = async (withCwd: boolean, withPorts: boolean): Promise<void> => {
    if (scanning) return
    scanning = true
    try {
      await scanActivity(withCwd, withPorts)
    } catch (err) {
      log.debug('terminal scan failed: %O', err)
    } finally {
      scanning = false
    }
  }

  // Watched terminals scan every second after any terminal I/O (a program
  // starting or exiting reads or writes), and every 5 s regardless; ports and
  // cwd every 5 s. With nobody watching (no viewer, or no client has the
  // person's attention), activity every 5 s and ports every 15 s.
  const tick = (): void => {
    ticks++
    const watched = attended() && liveTerms().some((t) => t.viewers.size > 0)
    const activity = (watched && ioSinceScan) || ticks % 5 === 0
    const slow = watched ? ticks % 5 === 0 : ticks % 15 === 0
    if (activity || slow) void runScan(watched && slow, slow)
  }

  const syncTimers = (): void => {
    const anyLive = liveTerms().length > 0
    if (anyLive && !scanTimer) {
      scanTimer = setInterval(tick, 1000)
      scanTimer.unref?.()
    } else if (!anyLive && scanTimer) {
      clearInterval(scanTimer)
      scanTimer = null
    }
    const wantIdle = anyLive && idleSuspendOn()
    if (wantIdle && !idleTimer) {
      idleTimer = setInterval(checkIdle, IDLE_CHECK_MS)
      idleTimer.unref?.()
    } else if (!wantIdle && idleTimer) {
      clearInterval(idleTimer)
      idleTimer = null
    }
  }

  // ---- Lifecycle ------------------------------------------------------------------------

  const saveScreen = (term: Term): void => {
    if (!term.log) return
    const capture = term.screen.capture()
    term.log.writeScrollbackSync(capture.screen + capture.pending.join(''))
  }

  /** Ends a terminal once, whichever comes first: its PTY exits, it is
   *  closed. Viewers get the exit and exit observers are told. */
  const endTerminal = (term: Term, exitCode: number): void => {
    if (!term.alive) return
    term.alive = false
    term.exitCode = exitCode
    term.suspended = false
    term.activity = { type: 'idle' }
    term.ports = []
    term.pauses.clear()
    for (const viewer of [...term.viewers.values()]) {
      if (viewer.lagTimer) clearTimeout(viewer.lagTimer)
      viewer.sink.emit({ kind: 'exit', code: exitCode })
      viewer.sink.end({ reason: 'exit', exitCode })
    }
    term.viewers.clear()
    term.fittedViewer = null
    saveScreen(term)
    term.log?.dispose()
    term.log = null
    syncTimers()
    touch(term)
    notify(exitObservers, term.id, exitCode)
  }

  const get = (id: string): Term => {
    const term = terms.get(id)
    if (!term) throw gone(id)
    return term
  }

  const killPty = (term: Term): void => {
    if (!term.alive) return
    resume(term)
    signalGroup(term.pid, 'SIGTERM')
    try { term.pty.kill() } catch { /* already dead */ }
  }

  const resolveLaunch = async (launch: LaunchIntent, cwd: string, panelId: string | null): Promise<LaunchPlan> => {
    const resolver = launchResolvers.get(launch.kind)
    if (!resolver) throw new RpcError('rejected', `Unknown launch intent "${launch.kind}"`)
    const plan = await resolver(launch.params, { cwd, panelId })
    const command = plan.command
    if (command && (typeof command.executable !== 'string' || !command.executable || !Array.isArray(command.args))) {
      throw new RpcError('rejected', 'Invalid launch command')
    }
    return plan
  }

  const spawnWithEnv = async (
    id: string,
    panelId: string | null,
    cwd: string,
    params: SpawnParams,
    executable: string,
    args: readonly string[],
  ): Promise<PtyProcess> => {
    let env = sanitizeEnv(deps.env())
    for (const contribute of envContributors) {
      const info: SpawnInfo = { terminalId: id, panelId, cwd, launch: params.launch ?? null, executable, args, env }
      try {
        const patch = await contribute(info)
        if (patch) env = { ...env, ...patch }
      } catch (err) {
        log.warn('terminal env contributor failed: %O', err)
      }
    }
    // Trust may have been revoked while contributors ran.
    deps.trust.requireTrusted()
    return spawnPty(executable, [...args], { name: 'xterm-256color', cols: params.cols, rows: params.rows, cwd, env })
  }

  const service: TerminalService = {
    async spawn(params) {
      deps.trust.requireTrusted()
      if (!validSize(params?.cols) || !validSize(params?.rows)) throw new RpcError('rejected', 'Invalid terminal size')
      const panelId = params.panelId || null
      const cwd = params.cwd ? await (deps.resolveCwd ? deps.resolveCwd(params.cwd) : params.cwd) : deps.root
      const plan = params.launch ? await resolveLaunch(params.launch, cwd, panelId) : {}
      const shell = plan.command ? null : resolveShell(params.shell || settings.defaultShellPath || undefined)
      const executable = plan.command?.executable ?? shell!.path
      const args = plan.command?.args ?? shell!.args
      const id = randomUUID()

      // From here the env contributors know the terminal: a spawn that fails
      // ends it for them like an exit.
      let pty: PtyProcess
      try {
        pty = await spawnWithEnv(id, panelId, cwd, params, executable, args)
      } catch (err) {
        notify(exitObservers, id, CLOSED_EXIT_CODE)
        throw err
      }
      const logKey = panelId ?? id
      const term: Term = {
        id,
        panelId,
        pid: pty.pid,
        shell: executable,
        pty,
        alive: true,
        exitCode: null,
        screen: new HeadlessScreen(params.cols, params.rows, settings.terminalScrollback),
        log: null,
        viewers: new Map(),
        fittedViewer: null,
        activity: { type: 'idle' },
        ports: [],
        cwd,
        lastOutputAt: Date.now(),
        suspended: false,
        pauses: new Set(),
        lastStatus: '',
      }
      terms.set(id, term)

      let restored = ''
      if (isSafeLogKey(logKey)) {
        if (params.restore && panelId) restored = readSavedScreen(deps.logDir, logKey)
        removeLogFiles(deps.logDir, logKey)
        try {
          term.log = new TerminalLog(deps.logDir, logKey)
        } catch (err) {
          log.warn('terminal log unavailable: %O', err)
        }
      }
      if (restored) output(term, restored + RESTORED_MARKER, false)
      if (shell?.notice) output(term, shell.notice, false)

      pty.onData((data) => { if (term.alive) output(term, data, true) })
      pty.onExit(({ exitCode }) => endTerminal(term, exitCode))
      if (plan.input) pty.write(plan.input + '\r')

      syncTimers()
      touch(term)
      return { id, pid: pty.pid, shell: executable }
    },

    write(id, data) {
      deps.trust.requireTrusted()
      const term = get(id)
      if (!term.alive || typeof data !== 'string' || !data) return
      resume(term)
      try { term.pty.write(data) } catch { return /* closed between exit and write */ }
      ioSinceScan = true
      notify(inputObservers, id, data)
    },

    view(params) {
      const term = get(params.id)
      const viewer = term.viewers.get(params.viewer)
      if (!viewer) return
      if (validSize(params.cols) && validSize(params.rows)) {
        viewer.cols = params.cols
        viewer.rows = params.rows
      }
      if (typeof params.visible === 'boolean' && params.visible !== viewer.visible) {
        viewer.visible = params.visible
        if (viewer.visible) resume(term)
      }
      if (params.fit) fitTo(term, viewer)
      else if (term.fittedViewer === viewer.id) {
        applySize(term)
        tellSize(term)
      }
    },

    attach(params, sink) {
      const term = get(params.id)
      const viewer: Viewer = {
        id: `v${++viewerSeq}`,
        sink,
        ...(validSize(params.cols) && validSize(params.rows) ? { cols: params.cols, rows: params.rows } : {}),
        visible: params.visible !== false,
        lastFit: 0,
        told: '',
        decoder: new TextDecoder(),
        lagTimer: null,
      }
      // A live PTY: the viewer joins (the first one has the PTY fit it) and
      // is told the grid and whether it fits before the screen comes.
      if (term.alive) {
        term.viewers.set(viewer.id, viewer)
        if (!term.fittedViewer) fitTo(term, viewer)
        tellSize(term)
      }
      // Screen, then what is written but not yet in it, then live output:
      // all synchronous, so nothing falls between.
      const capture = term.screen.capture()
      sink.emit({ kind: 'screen', viewer: viewer.id, data: capture.screen, cols: capture.cols, rows: capture.rows })
      for (const chunk of capture.pending) sink.bytes(encoder.encode(chunk))
      if (!term.alive) {
        sink.emit({ kind: 'exit', code: term.exitCode ?? 0 })
        sink.end({ reason: 'exit', ...(term.exitCode !== null ? { exitCode: term.exitCode } : {}) })
        return () => {}
      }
      if (viewer.visible) resume(term)
      sink.onInput((bytes) => {
        if (!term.alive || !deps.trust.isTrusted()) return
        const data = viewer.decoder.decode(bytes, { stream: true })
        if (!data) return
        resume(term)
        try { term.pty.write(data) } catch { return }
        ioSinceScan = true
        notify(inputObservers, term.id, data)
      })
      syncTimers()
      touch(term)
      return () => dropViewer(term, viewer)
    },

    kill(id) {
      killPty(get(id))
    },

    close(id) {
      const term = terms.get(id)
      if (!term) return
      killPty(term)
      for (const viewer of [...term.viewers.values()]) {
        dropViewer(term, viewer)
        viewer.sink.end({ reason: 'closed' })
      }
      terms.delete(id)
      // Its log files go below, so nothing to save.
      term.log?.dispose()
      term.log = null
      endTerminal(term, CLOSED_EXIT_CODE)
      term.screen.dispose()
      const key = term.panelId ?? term.id
      if (isSafeLogKey(key)) removeLogFiles(deps.logDir, key)
      syncTimers()
      emitStatus({ [id]: null })
    },

    async cwd(id) {
      const term = get(id)
      if (!term.alive) return term.cwd
      const cwd = await scanner.cwd(term.pid).catch(() => null)
      if (cwd && cwd !== term.cwd) {
        term.cwd = cwd
        touch(term)
      }
      return cwd ?? term.cwd
    },

    async read(id, lines) {
      const term = get(id)
      await term.screen.settled()
      return term.screen.read(lines)
    },

    async snapshot(id) {
      const term = get(id)
      await term.screen.settled()
      const capture = term.screen.capture()
      return { data: capture.screen + capture.pending.join(''), cols: capture.cols, rows: capture.rows }
    },

    list: () => [...terms.values()].map(statusOf),

    statuses: () => Object.fromEntries([...terms.values()].map((t) => [t.id, statusOf(t)])),

    onStatusChange(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },

    busy: () => liveTerms().some((t) => t.activity.type === 'running'),

    scan: () => runScan(true, true),

    registerEnvContributor(contributor) {
      envContributors.add(contributor)
      return () => envContributors.delete(contributor)
    },

    registerLaunchIntent(kind, resolver) {
      if (launchResolvers.has(kind)) throw new Error(`Launch intent "${kind}" is already registered`)
      launchResolvers.set(kind, resolver)
      return () => { if (launchResolvers.get(kind) === resolver) launchResolvers.delete(kind) }
    },

    onOutput(observer) {
      outputObservers.add(observer)
      return () => outputObservers.delete(observer)
    },

    onInput(observer) {
      inputObservers.add(observer)
      return () => inputObservers.delete(observer)
    },

    onExit(observer) {
      exitObservers.add(observer)
      return () => exitObservers.delete(observer)
    },

    onActivity(observer) {
      activityObservers.add(observer)
      return () => activityObservers.delete(observer)
    },

    async shutdown() {
      stopSettings()
      if (scanTimer) clearInterval(scanTimer)
      if (idleTimer) clearInterval(idleTimer)
      scanTimer = idleTimer = null
      const live = [...terms.values()].filter((term) => term.alive)
      // Hang up like a closing window: the shell passes SIGHUP to its jobs,
      // background ones included (they have process groups of their own).
      // SIGCONT first: a stopped group acts only once resumed.
      for (const term of live) {
        saveScreen(term)
        signalGroup(term.pid, 'SIGCONT')
        try { term.pty.kill() } catch { /* already dead */ }
      }
      const deadline = Date.now() + SHUTDOWN_GRACE_MS
      while (live.some((term) => term.alive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
      // Whatever ignored the hangup.
      for (const term of live) {
        if (term.alive) signalGroup(term.pid, 'SIGKILL')
        term.alive = false
      }
      for (const term of terms.values()) {
        term.log?.dispose()
        term.log = null
      }
    },
  }
  return service
}
