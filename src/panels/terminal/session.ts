// The terminal panel session (architecture 11.2, 11.3): owns the panel's PTY in
// the runtime. It spawns (or restores) the PTY in `start()` in its checkout,
// follows the terminal service's status of that PTY, hosts the resume stamp
// the agents service hands it, and serves `cate.terminal.*`.
//
// Output does not go through the session channel. A view attaches to the
// terminal service's `process.attach` with the snapshot's `ptyId` (through
// `bindTerminal`): that stream already carries the serialized screen for each
// new viewer, per-viewer flow control with acks, lag recovery and the viewer's
// size and activity. Relaying it here would need one attach per subscriber and
// a second flow control layer for the same bytes, so there is one path only.

import { sessionApi } from '@kernel/api/contract'
import { RpcError, isRpcError } from '@kernel/rpc/contract'
import type { Json, PanelRecord } from '@workspace/document/contract'
import type { AgentSendResult, TerminalResumeStamp } from '@services/agents/contract'
import type { LaunchIntent, TerminalStatus } from '@services/terminal/contract'
import type { TerminalService } from '@services/terminal/runtime'
import { PanelSession, type OpHandlers, type SessionKit, type DisposeReason } from '@panels/framework/runtime'
import { terminalApi } from './contract/api'
import { sequenceForKeys } from './contract/keys'
import type {
  SubmitResult,
  TerminalOp,
  TerminalOpenTarget,
  TerminalPersisted,
  TerminalSnapshot,
} from './contract/types'

/** The part of the terminal service a session uses. */
export type SessionTerminalService = Pick<
  TerminalService,
  'spawn' | 'write' | 'kill' | 'close' | 'read' | 'statuses' | 'onStatusChange'
>

/** The agents terminal runner, as a terminal panel sees it. */
export interface TerminalAgentRunner {
  state(panelId: string): { present: boolean } | null
  /** Submits a prompt as the user would; flushes connected editors first. */
  send(panelId: string, prompt: string): Promise<AgentSendResult>
  onResumeStamp(listener: (panelId: string, stamp: TerminalResumeStamp | null) => void): () => void
  /** The launch intent that resumes a stamp in a fresh shell. */
  resumeLaunch(stamp: TerminalResumeStamp): LaunchIntent | null
}

export interface TerminalSessionDeps {
  terminal: SessionTerminalService
  /** Canonical workspace root: the cwd of a terminal bound to no checkout. */
  root: string
  agents?: TerminalAgentRunner
  /** Opens a clicked link inside Cate (a browser or editor panel near this one). */
  open?(target: TerminalOpenTarget, fromPanelId: string): unknown
  /** A one-shot launch for the panel's first spawn (a started agent). */
  takeLaunch?(panelId: string): LaunchIntent | undefined
}

const INITIAL_COLS = 80
const INITIAL_ROWS = 24

const shellName = (shell: string): string => shell.split(/[\\/]/).pop() || shell

const initialSnapshot = (): TerminalSnapshot => ({
  ptyId: null,
  status: 'starting',
  title: '',
  cwd: null,
  activity: { type: 'idle' },
  exitCode: null,
  error: null,
})

interface SpawnOptions {
  cwd?: string
  launch?: LaunchIntent
  restore?: boolean
}

export class TerminalSession extends PanelSession<TerminalSnapshot, TerminalOp> {
  private readonly offs: Array<() => void> = []
  private shell = ''
  private stamp: TerminalResumeStamp | null = null
  private lastCwd: string | null = null
  /** Bumped by every spawn and by dispose; a stale spawn closes its PTY. */
  private generation = 0
  private spawning: Promise<void> = Promise.resolve()

  constructor(kit: SessionKit, record: PanelRecord, private readonly deps: TerminalSessionDeps) {
    super(kit, record, initialSnapshot())
  }

  get ptyId(): string | null { return this.state.ptyId }

  /** A live PTY runs a foreground program other than its shell. */
  busy(): boolean {
    return this.state.status === 'running' && this.state.activity.type === 'running'
  }

  override async start(): Promise<void> {
    const saved = this.persisted<TerminalPersisted>()
    this.stamp = saved?.stamp ?? null
    this.lastCwd = saved?.cwd ?? null
    this.offs.push(this.deps.terminal.onStatusChange((change) => {
      const id = this.state.ptyId
      if (id && Object.prototype.hasOwnProperty.call(change, id)) this.followStatus(change[id])
    }))
    const agents = this.deps.agents
    if (agents) {
      this.offs.push(agents.onResumeStamp((panelId, stamp) => {
        if (panelId !== this.panelId) return
        this.stamp = stamp
        this.save()
      }))
    }
    const launch = this.deps.takeLaunch?.(this.panelId)
    await this.respawn(launch
      ? { launch }
      : { cwd: this.lastCwd ?? undefined, launch: this.resumeLaunch(), restore: true })
  }

  /** Runs `launch` as the panel's process in a fresh PTY; whatever ran dies.
   *  For an agent started in this panel, which asks for it explicitly. */
  async launch(launch: LaunchIntent, target: { cwd?: string; worktreeId?: string } = {}): Promise<void> {
    if (target.worktreeId !== undefined || target.cwd !== undefined) this.bind(target.worktreeId ?? null, target.cwd)
    await this.respawn({ cwd: target.cwd, launch })
  }

  /** Screen and scrollback as text, the last `lines` lines when given. */
  async read(lines?: number): Promise<{ alt: boolean; text: string }> {
    const id = this.state.ptyId
    if (!id) throw new RpcError('rejected', 'terminal-not-ready')
    return this.deps.terminal.read(id, lines)
  }

  terminate(): void {
    const id = this.state.ptyId
    if (id && this.state.status === 'running') this.deps.terminal.kill(id)
  }

  protected override readonly ops: OpHandlers<TerminalOp> = {
    input: ({ data }) => { this.write(data) },
    submit: ({ text }) => this.submit(text),
    terminate: () => { this.terminate() },
    restart: async ({ discard }) => {
      this.requireIdle(discard)
      await this.respawn({})
    },
    switchWorktree: async ({ worktreeId, discard }) => {
      const path = worktreeId ? this.kit.document.get().worktrees[worktreeId]?.path : this.deps.root
      if (!path) throw new RpcError('gone', `no worktree ${worktreeId}`)
      this.requireIdle(discard)
      this.bind(worktreeId, path)
      await this.respawn({ cwd: path })
    },
    openUrl: ({ url }) => this.open({ kind: 'url', url }),
    openFile: ({ path, line, column }) => this.open({
      kind: 'file',
      path,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    }),
  }

  override handleApi = sessionApi(terminalApi, {
    read: async ({ lines }) => ({ panelId: this.panelId, ...await this.read(lines as number | undefined) }),
    type: ({ text }) => {
      this.write(text)
      return { panelId: this.panelId }
    },
    press: ({ keys }) => {
      const seq = sequenceForKeys(keys)
      if ('unknown' in seq) throw new RpcError('rejected', `unsupported key "${seq.unknown}"`)
      this.write(seq.data)
      return { panelId: this.panelId }
    },
  })

  /** A running program would be killed. */
  override closeBlocker(): RpcError | null {
    try {
      this.requireIdle(false)
      return null
    } catch (err) {
      return err as RpcError
    }
  }

  protected override release(reason: DisposeReason): void {
    this.generation++
    for (const off of this.offs.splice(0)) off()
    // On shutdown the service saves every screen for the restore.
    const id = this.state.ptyId
    if (id && reason !== 'shutdown') this.closePty(id)
  }

  // ---- Internals ------------------------------------------------------------

  private requireIdle(discard: boolean | undefined): void {
    if (discard || !this.busy()) return
    const activity = this.state.activity
    const processName = activity.type === 'running' ? activity.processName : null
    throw new RpcError('dirty', `${processName ?? 'A process'} is running in ${this.record.title}`, { processName })
  }

  private write(data: string): void {
    const id = this.state.ptyId
    if (!id || this.state.status !== 'running') throw new RpcError('rejected', 'terminal-not-ready')
    this.deps.terminal.write(id, data)
  }

  private async submit(text: string): Promise<SubmitResult> {
    const agents = this.deps.agents
    if (agents?.state(this.panelId)?.present) return agents.send(this.panelId, text)
    const id = this.state.ptyId
    if (!id || this.state.status !== 'running') return { ok: false, error: 'terminal-not-ready' }
    this.deps.terminal.write(id, text.replace(/\r?\n/g, '\r'))
    this.deps.terminal.write(id, '\r')
    return { ok: true }
  }

  private open(target: TerminalOpenTarget): unknown {
    if (!this.deps.open) throw new RpcError('unsupported', 'links cannot open inside Cate here')
    return this.deps.open(target, this.panelId)
  }

  /** The checkout this panel works in: its worktree, its opening cwd, the root. */
  private checkoutCwd(): string {
    const worktreeId = this.record.worktreeId
    const worktree = worktreeId ? this.kit.document.get().worktrees[worktreeId] : undefined
    const cwd = this.record.fields.cwd
    return worktree?.path ?? (typeof cwd === 'string' && cwd ? cwd : this.deps.root)
  }

  /** Records the checkout switch; the stamp and cwd of the old one go. */
  private bind(worktreeId: string | null, cwd: string | undefined): void {
    this.kit.document.apply({
      kind: 'updatePanel',
      id: this.panelId,
      patch: { worktreeId, fields: { cwd: cwd ?? null } },
    })
    this.stamp = null
    this.lastCwd = null
    this.save()
  }

  private resumeLaunch(): LaunchIntent | undefined {
    return (this.stamp && this.deps.agents?.resumeLaunch(this.stamp)) || undefined
  }

  private closePty(id: string): void {
    try { this.deps.terminal.close(id) } catch (err) { this.kit.log.warn('closing terminal %s failed: %O', id, err) }
  }

  /** Spawns after any spawn in flight, replacing the current PTY. */
  private respawn(options: SpawnOptions): Promise<void> {
    const run = this.spawning.then(() => this.spawn(options))
    this.spawning = run.catch(() => {})
    return run
  }

  private async spawn(options: SpawnOptions): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    // The old PTY goes first: the new one reuses the panel's log files.
    const previous = this.state.ptyId
    if (previous) this.closePty(previous)
    this.publish({ ptyId: null, status: 'starting', exitCode: null, error: null, activity: { type: 'idle' } })

    const base = this.checkoutCwd()
    const attempt = (cwd: string) => this.deps.terminal.spawn({
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      cwd,
      panelId: this.panelId,
      ...(options.launch ? { launch: options.launch } : {}),
      ...(options.restore ? { restore: true } : {}),
    })
    let cwd = options.cwd ?? base
    let result: Awaited<ReturnType<typeof attempt>>
    try {
      try {
        result = await attempt(cwd)
      } catch (err) {
        // A remembered cwd may be gone; the checkout is the fallback.
        if (cwd === base || isRpcError(err, 'untrusted')) throw err
        cwd = base
        result = await attempt(cwd)
      }
    } catch (err) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    if (this.disposed || generation !== this.generation) {
      this.closePty(result.id)
      return
    }
    this.shell = result.shell
    this.publish({ ptyId: result.id, status: 'running', title: shellName(result.shell), cwd })
    this.rememberCwd(cwd)
    this.followStatus(this.deps.terminal.statuses()[result.id] ?? null)
  }

  private followStatus(status: TerminalStatus | null | undefined): void {
    if (!status) return
    const title = status.activity.type === 'running' ? status.activity.processName : shellName(this.shell || status.shell)
    this.publish({
      activity: status.activity,
      title,
      ...(status.cwd ? { cwd: status.cwd } : {}),
      ...(status.alive ? {} : { status: 'exited' as const, exitCode: status.exitCode, activity: { type: 'idle' as const } }),
    })
    if (status.cwd) this.rememberCwd(status.cwd)
  }

  private rememberCwd(cwd: string): void {
    if (cwd === this.lastCwd) return
    this.lastCwd = cwd
    this.save()
  }

  private save(): void {
    const value: TerminalPersisted = { cwd: this.lastCwd, stamp: this.stamp }
    this.persist(JSON.parse(JSON.stringify(value)) as Json)
  }
}
