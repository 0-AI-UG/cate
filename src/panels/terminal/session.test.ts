import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@kernel/log/contract'
import { isRpcError, RpcError } from '@kernel/rpc/contract'
import type { ApiSessionContext } from '@kernel/api/contract'
import type { Json, PanelRecord, WorkspaceDocument } from '@workspace/document/contract'
import { createDocument } from '@workspace/document/contract'
import type { TerminalResumeStamp } from '@services/agents/contract'
import type { SpawnParams, TerminalStatus, TerminalStatusChange } from '@services/terminal/contract'
import type { SessionKit } from '@panels/framework/runtime'
import { TerminalSession, type SessionTerminalService, type TerminalAgentRunner } from './session'
import { createTerminalPanels } from './runtime'
import type { TerminalSnapshot } from './contract'

function fakeTerminal() {
  const spawns: SpawnParams[] = []
  const writes: Array<{ id: string; data: string }> = []
  const closed: string[] = []
  const killed: string[] = []
  const statuses: Record<string, TerminalStatus> = {}
  const listeners = new Set<(change: TerminalStatusChange) => void>()
  let seq = 0
  let failNext: Error | null = null
  const service: SessionTerminalService = {
    async spawn(params) {
      spawns.push(params)
      if (failNext) {
        const err = failNext
        failNext = null
        throw err
      }
      const id = `pty-${++seq}`
      statuses[id] = {
        id, panelId: params.panelId ?? null, pid: 100 + seq, shell: '/bin/zsh', alive: true, exitCode: null,
        activity: { type: 'idle' }, ports: [], cwd: params.cwd ?? null, suspended: false, viewers: 0,
      }
      return { id, pid: 100 + seq, shell: '/bin/zsh' }
    },
    write: (id, data) => { writes.push({ id, data }) },
    kill: (id) => { killed.push(id) },
    close: (id) => { closed.push(id) },
    read: async (id, lines) => ({ alt: false, text: `screen of ${id}${lines ? ` (${lines})` : ''}` }),
    statuses: () => statuses,
    onStatusChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const update = (id: string, patch: Partial<TerminalStatus>) => {
    statuses[id] = { ...statuses[id], ...patch }
    for (const listener of listeners) listener({ [id]: statuses[id] })
  }
  return { service, spawns, writes, closed, killed, update, failOnce: (err: Error) => { failNext = err } }
}

function fakeAgents() {
  const stampListeners = new Set<(panelId: string, stamp: TerminalResumeStamp | null) => void>()
  const runner: TerminalAgentRunner = {
    onResumeStamp: (l) => { stampListeners.add(l); return () => { stampListeners.delete(l) } },
    resumeLaunch: (stamp) => ({ kind: 'agents.resume', params: stamp }),
  }
  return {
    runner,
    stamp(panelId: string, stamp: TerminalResumeStamp | null) {
      for (const l of stampListeners) l(panelId, stamp)
    },
  }
}

function fakeKit(record: PanelRecord, saved?: Json) {
  let doc: WorkspaceDocument = {
    ...createDocument(),
    panels: { [record.id]: record },
    worktrees: { wt: { id: 'wt', path: '/repo/.worktrees/wt', color: 'green', status: 'ready' as never } },
  }
  let stored = saved
  const applied: unknown[] = []
  const kit = {
    panelId: record.id,
    document: {
      get: () => doc,
      apply: (change: unknown) => {
        applied.push(change)
        const c = change as { kind: string; id: string; patch: { worktreeId?: string | null; fields?: Record<string, Json> } }
        if (c.kind === 'updatePanel') {
          const current = doc.panels[c.id]
          const fields = { ...current.fields, ...c.patch.fields }
          for (const [k, v] of Object.entries(fields)) if (v === null) delete fields[k]
          const next: PanelRecord = { ...current, fields }
          if (c.patch.worktreeId) next.worktreeId = c.patch.worktreeId
          else delete next.worktreeId
          doc = { ...doc, panels: { ...doc.panels, [c.id]: next } }
        }
        return 1
      },
    },
    store: { read: () => stored, write: (value: Json) => { stored = value }, flush: async () => {} },
    log: createLogger('test'),
    surface: async () => undefined,
    session: () => undefined,
  } as unknown as SessionKit
  return { kit, applied, stored: () => stored, doc: () => doc }
}

const record = (fields: Record<string, Json> = {}, worktreeId?: string): PanelRecord => ({
  id: 'p1', type: 'terminal', title: 'Terminal 1', fields, ...(worktreeId ? { worktreeId } : {}),
})

function setup(options: { fields?: Record<string, Json>; worktreeId?: string; saved?: Json; agents?: boolean } = {}) {
  const terminal = fakeTerminal()
  const agents = options.agents ? fakeAgents() : undefined
  const k = fakeKit(record(options.fields, options.worktreeId), options.saved)
  const open = vi.fn()
  const session = new TerminalSession(k.kit, record(options.fields, options.worktreeId), {
    terminal: terminal.service,
    root: '/repo',
    agents: agents?.runner,
    open,
  })
  return { terminal, agents, session, open, ...k }
}

const snap = (session: TerminalSession): TerminalSnapshot => session.snapshot()
const ctx = { panelId: 'p1', method: 'cate.terminal.x' } as unknown as ApiSessionContext
const opCtx = { clientId: 'c1', connectionId: 1 }

describe('TerminalSession', () => {
  it('has no side effects until start, then spawns in its checkout', async () => {
    const { session, terminal } = setup({ worktreeId: 'wt' })
    expect(terminal.spawns).toEqual([])
    await session.start()
    expect(terminal.spawns).toHaveLength(1)
    expect(terminal.spawns[0]).toMatchObject({ cwd: '/repo/.worktrees/wt', panelId: 'p1', restore: true })
    expect(terminal.spawns[0].launch).toBeUndefined()
    expect(snap(session)).toMatchObject({ ptyId: 'pty-1', status: 'running', title: 'zsh', cwd: '/repo/.worktrees/wt' })
  })

  it('falls back to the record cwd, then the root', async () => {
    const a = setup({ fields: { cwd: '/repo/sub' } })
    await a.session.start()
    expect(a.terminal.spawns[0].cwd).toBe('/repo/sub')
    const b = setup()
    await b.session.start()
    expect(b.terminal.spawns[0].cwd).toBe('/repo')
  })

  it('publishes a failed spawn and restarts on request', async () => {
    const { session, terminal } = setup()
    terminal.failOnce(new RpcError('untrusted', 'workspace is not trusted'))
    await session.start()
    expect(snap(session)).toMatchObject({ status: 'failed', error: 'workspace is not trusted', ptyId: null })
    await session.handleOp({ kind: 'restart' }, opCtx)
    expect(snap(session)).toMatchObject({ status: 'running', ptyId: 'pty-1', error: null })
  })

  it('follows the PTY status: activity, title, cwd and exit', async () => {
    const { session, terminal } = setup()
    await session.start()
    terminal.update('pty-1', { activity: { type: 'running', processName: 'vim' }, cwd: '/repo/src' })
    expect(snap(session)).toMatchObject({ title: 'vim', cwd: '/repo/src', activity: { type: 'running', processName: 'vim' } })
    terminal.update('pty-1', { alive: false, exitCode: 3, activity: { type: 'idle' } })
    expect(snap(session)).toMatchObject({ status: 'exited', exitCode: 3, title: 'zsh' })
  })

  it('refuses to close with dirty while a program runs, unless discarded', async () => {
    const { session, terminal } = setup()
    await session.start()
    expect(session.closeBlocker()).toBeNull()
    terminal.update('pty-1', { activity: { type: 'running', processName: 'npm' } })
    const error = session.closeBlocker()
    expect(isRpcError(error, 'dirty')).toBe(true)
    expect(error!.data).toEqual({ processName: 'npm' })
    await expect(session.handleOp({ kind: 'restart' }, opCtx)).rejects.toMatchObject({ code: 'dirty' })
  })

  it('closes its PTY when removed but not on shutdown', async () => {
    const a = setup()
    await a.session.start()
    a.session.dispose('removed')
    expect(a.terminal.closed).toEqual(['pty-1'])
    const b = setup()
    await b.session.start()
    b.session.dispose('shutdown')
    expect(b.terminal.closed).toEqual([])
  })

  it('serves cate.terminal read, type and press', async () => {
    const { session, terminal } = setup()
    await session.start()
    await expect(session.handleApi!('read', { lines: 5 }, ctx)).resolves.toEqual({ panelId: 'p1', alt: false, text: 'screen of pty-1 (5)' })
    await session.handleApi!('type', { text: 'ls -la' }, ctx)
    await session.handleApi!('press', { keys: 'ctrl-c Enter' }, ctx)
    expect(terminal.writes).toEqual([{ id: 'pty-1', data: 'ls -la' }, { id: 'pty-1', data: '\x03\r' }])
    await expect(session.handleApi!('press', { keys: 'hyper' }, ctx)).rejects.toMatchObject({ code: 'rejected' })
  })

  it('reads an exited terminal but refuses input to it', async () => {
    const { session, terminal } = setup()
    await session.start()
    terminal.update('pty-1', { alive: false, exitCode: 0 })
    await expect(session.handleApi!('read', {}, ctx)).resolves.toMatchObject({ text: 'screen of pty-1' })
    await expect(session.handleApi!('type', { text: 'x' }, ctx)).rejects.toMatchObject({ code: 'rejected' })
  })

  it('persists resume stamps and resumes them on restore', async () => {
    const first = setup({ agents: true })
    await first.session.start()
    const stamp: TerminalResumeStamp = { agentId: 'codex', sessionId: 's-1', cwd: '/repo' }
    first.agents!.stamp('p1', stamp)
    first.agents!.stamp('other', { ...stamp, sessionId: 'nope' })
    expect(first.stored()).toEqual({ cwd: '/repo', stamp })

    const second = setup({ agents: true, saved: first.stored() })
    await second.session.start()
    expect(second.terminal.spawns[0]).toMatchObject({ cwd: '/repo', restore: true, launch: { kind: 'agents.resume', params: stamp } })
  })

  it('restores in its last cwd and falls back to the checkout when it is gone', async () => {
    const { session, terminal } = setup({ saved: { cwd: '/repo/gone', stamp: null } })
    terminal.failOnce(new Error('ENOENT'))
    await session.start()
    expect(terminal.spawns.map((s) => s.cwd)).toEqual(['/repo/gone', '/repo'])
    expect(snap(session)).toMatchObject({ status: 'running', cwd: '/repo' })
  })

  it('switches worktree: records it, drops the stamp and spawns a fresh shell there', async () => {
    const { session, terminal, agents, applied, stored } = setup({ agents: true })
    await session.start()
    agents!.stamp('p1', { agentId: 'codex', sessionId: 's', cwd: '/repo' })
    await session.handleOp({ kind: 'switchWorktree', worktreeId: 'wt' }, opCtx)
    expect(applied).toEqual([{ kind: 'updatePanel', id: 'p1', patch: { worktreeId: 'wt', fields: { cwd: '/repo/.worktrees/wt' } } }])
    expect(terminal.closed).toEqual(['pty-1'])
    expect(terminal.spawns[1]).toMatchObject({ cwd: '/repo/.worktrees/wt' })
    expect(terminal.spawns[1].restore).toBeUndefined()
    expect(snap(session).ptyId).toBe('pty-2')
    expect(stored()).toEqual({ cwd: '/repo/.worktrees/wt', stamp: null })
    await expect(session.handleOp({ kind: 'switchWorktree', worktreeId: 'missing' }, opCtx)).rejects.toMatchObject({ code: 'gone' })
  })

  it('terminates, opens links through its deps and rejects unknown ops', async () => {
    const { session, terminal, open } = setup()
    await session.start()
    await session.handleOp({ kind: 'terminate' }, opCtx)
    expect(terminal.killed).toEqual(['pty-1'])
    await session.handleOp({ kind: 'openFile', path: '/repo/a.ts', line: 3 }, opCtx)
    expect(open).toHaveBeenCalledWith({ kind: 'file', path: '/repo/a.ts', line: 3 }, 'p1')
    await expect(session.handleOp({ kind: 'nope' }, opCtx)).rejects.toMatchObject({ code: 'rejected' })
  })

  it('closes a PTY whose spawn finished after dispose', async () => {
    const { session, terminal } = setup()
    const spawn = terminal.service.spawn
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    terminal.service.spawn = async (params) => { const result = await spawn(params); await gate; return result }
    const started = session.start()
    await vi.waitFor(() => expect(terminal.spawns).toHaveLength(1))
    session.dispose('removed')
    release()
    await started
    expect(terminal.closed).toEqual(['pty-1'])
    expect(snap(session).ptyId).toBeNull()
  })
})

describe('createTerminalPanels', () => {
  it('hands a pending launch to the first spawn only', async () => {
    const terminal = fakeTerminal()
    const panels = createTerminalPanels({ terminal: terminal.service, root: '/repo' })
    const k = fakeKit(record())
    let added: PanelRecord | null = null
    let placed: unknown
    const kit = {
      newId: () => 'p1',
      record: (_type: string, init: { id: string; title?: string; fields?: Record<string, Json> }) =>
        ({ id: init.id, type: 'terminal', title: init.title ?? 'Terminal', fields: init.fields ?? {} }) as PanelRecord,
      add: (r: PanelRecord, placement: unknown) => { added = r; placed = placement; return r.id },
      uniqueTitle: (title: string) => title,
    }
    const sessions = new Map<string, TerminalSession>()
    const terminals = panels.agentTerminals(kit as never, {
      started: async (panelId) => {
        const session = new panels.session(k.kit, added!) as unknown as TerminalSession
        sessions.set(panelId, session)
        await session.start()
      },
    })
    const launch = { kind: 'agents.start', params: { agentId: 'codex', prompt: 'go' } }
    await expect(terminals.create({ cwd: '/repo', title: 'Agent', launch, placement: { near: 'canvas' } })).resolves.toBe('p1')
    expect(placed).toEqual({ near: 'canvas' })
    expect(terminal.spawns[0]).toMatchObject({ launch, cwd: '/repo' })
    expect(terminal.spawns[0].restore).toBeUndefined()
    expect(terminals.state('p1')).toEqual({ alive: true, busy: false })
    expect(terminals.state('nope')).toBeNull()
    await sessions.get('p1')!.handleOp({ kind: 'restart' }, opCtx)
    expect(terminal.spawns[1].launch).toBeUndefined()
  })
})
