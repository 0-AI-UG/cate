import { describe, expect, it } from 'vitest'
import type { TerminalSnapshot } from '@panels/terminal/contract'
import { base64ToBytes } from '@workspace/files/contract'
import type { MobileBridge, MobileTerminalEvent } from '../contract'
import type { MobileClient } from './boot'
import { createMobileTerminals } from './terminals'

const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeAttach() {
  const views: unknown[] = []
  const attaches: Array<{
    params: { id: string; cols?: number; rows?: number}
    emit(event: unknown): void
    bytes(chunk: Uint8Array): void
    written: string[]
    acked: number
    cancelled: boolean
  }> = []
  const process = {
    attach(params: { id: string; cols?: number; rows?: number}) {
      const events = new Set<(e: unknown) => void>()
      const byteListeners = new Set<(b: Uint8Array) => void>()
      const entry = {
        params,
        emit: (e: unknown) => { for (const l of events) l(e) },
        bytes: (b: Uint8Array) => { for (const l of byteListeners) l(b) },
        written: [] as string[],
        acked: 0,
        cancelled: false,
      }
      attaches.push(entry)
      return {
        onEvent: (l: (e: unknown) => void) => { events.add(l); return () => events.delete(l) },
        onBytes: (l: (b: Uint8Array) => void) => { byteListeners.add(l); return () => byteListeners.delete(l) },
        write: (b: Uint8Array) => { entry.written.push(new TextDecoder().decode(b)) },
        ack: (n: number) => { entry.acked += n },
        cancel: () => { entry.cancelled = true },
        done: new Promise(() => {}),
      }
    },
    view: async (params: unknown) => { views.push(params) },
  }
  return { process, attaches, views }
}

function setup() {
  const { process, attaches, views } = fakeAttach()
  let snapshot: TerminalSnapshot | null = null
  const sessionListeners = new Set<() => void>()
  const session = {
    released: false,
    getSnapshot: () => (snapshot ? { rev: 1, snapshot } : null),
    subscribe: (l: () => void) => { sessionListeners.add(l); return () => sessionListeners.delete(l) },
    release() { this.released = true },
  }
  const connection = { runtime: { process }, subscribeSession: () => session }
  const client = {
    connections: { get: (id: string) => (id === 'ws1' ? connection : undefined), subscribe: () => () => {} },
  } as unknown as MobileClient
  const events: MobileTerminalEvent[] = []
  const bridge = (async (method: string, params: MobileTerminalEvent) => {
    if (method === 'terminal.event') events.push(params)
    return null
  }) as MobileBridge
  const setSnapshot = (next: Partial<TerminalSnapshot>) => {
    snapshot = { ptyId: null, status: 'running', title: 'zsh', cwd: null, activity: { type: 'idle' }, agent: null, exitCode: null, error: null, ...next }
    for (const l of sessionListeners) l()
  }
  return { terminals: createMobileTerminals(client, bridge), attaches, views, events, session, setSnapshot }
}

const output = (events: MobileTerminalEvent[]) => events
  .flatMap((e) => (e.kind === 'output' ? [new TextDecoder().decode(base64ToBytes(e.data))] : e.kind === 'reset' ? ['<reset>'] : []))
  .join('')

describe('mobile terminals', () => {
  it('streams the panel PTY to the app and sends its keystrokes back', async () => {
    const t = setup()
    t.setSnapshot({ ptyId: 'pty-1' })
    t.terminals.open({ terminalId: 'v', workspaceId: 'ws1', panelId: 'p1', cols: 45, rows: 30 })
    // Attaches with the grid the phone holds, as every viewer does.
    expect(t.attaches.map((a) => [a.params.id, a.params.cols, a.params.rows])).toEqual([['pty-1', 45, 30]])

    t.attaches[0].emit({ kind: 'screen', viewer: 'v1', data: 'prompt$ ', cols: 40, rows: 20 })
    t.attaches[0].bytes(new TextEncoder().encode('ls\r\n'))
    await tick()
    expect(output(t.events)).toBe('<reset>prompt$ ls\r\n')
    // Live output is acknowledged once the app took it.
    expect(t.attaches[0].acked).toBe(4)

    t.terminals.get('v')!.input('pwd\r')
    expect(t.attaches[0].written).toEqual(['pwd\r'])
  })

  it('gives the app the PTY grid before the screen, and every change with whether it fits', async () => {
    const t = setup()
    t.setSnapshot({ ptyId: 'pty-1' })
    t.terminals.open({ terminalId: 'v', workspaceId: 'ws1', panelId: 'p1', cols: 45, rows: 30 })
    t.attaches[0].emit({ kind: 'screen', viewer: 'v1', data: 'x', cols: 120, rows: 40 })
    t.attaches[0].emit({ kind: 'size', cols: 120, rows: 40, fitted: false })
    t.attaches[0].emit({ kind: 'size', cols: 45, rows: 30, fitted: true })
    await tick()
    expect(t.events.filter((e) => e.kind !== 'state').map((e) => e.kind === 'size' ? [e.cols, e.rows, e.fitted] : e.kind))
      .toEqual([[120, 40, false], 'reset', 'output', [45, 30, true]])
  })

  it('reports the grid it holds and fits when asked', async () => {
    const t = setup()
    t.setSnapshot({ ptyId: 'pty-1' })
    t.terminals.open({ terminalId: 'v', workspaceId: 'ws1', panelId: 'p1', cols: 45, rows: 30 })
    t.attaches[0].emit({ kind: 'screen', viewer: 'v1', data: '', cols: 120, rows: 40 })
    expect(t.views).toEqual([{ id: 'pty-1', viewer: 'v1', cols: 45, rows: 30, visible: true }])
    t.terminals.get('v')!.resize(90, 20)
    expect(t.views.at(-1)).toEqual({ id: 'pty-1', viewer: 'v1', cols: 90, rows: 20, visible: true })
    t.terminals.get('v')!.fit()
    expect(t.views.at(-1)).toEqual({ id: 'pty-1', viewer: 'v1', cols: 90, rows: 20, visible: true, fit: true })
  })

  it('follows the panel to a new PTY and reports its state', async () => {
    const t = setup()
    t.setSnapshot({ ptyId: 'pty-1' })
    t.terminals.open({ terminalId: 'v', workspaceId: 'ws1', panelId: 'p1', cols: 45, rows: 30 })
    t.setSnapshot({ ptyId: 'pty-1', status: 'exited', exitCode: 1 })
    t.setSnapshot({ ptyId: 'pty-2', status: 'running' })
    await tick()
    expect(t.attaches.map((a) => [a.params.id, a.cancelled])).toEqual([['pty-1', true], ['pty-2', false]])
    expect(t.events.filter((e) => e.kind === 'state')).toEqual([
      { terminalId: 'v', kind: 'state', status: 'running', text: null },
      { terminalId: 'v', kind: 'state', status: 'exited', text: 'The process exited with code 1.' },
      { terminalId: 'v', kind: 'state', status: 'running', text: null },
    ])
  })

  it('detaches and releases the session on close', () => {
    const t = setup()
    t.setSnapshot({ ptyId: 'pty-1' })
    t.terminals.open({ terminalId: 'v', workspaceId: 'ws1', panelId: 'p1', cols: 45, rows: 30 })
    t.terminals.get('v')!.close()
    expect(t.attaches[0].cancelled).toBe(true)
    expect(t.session.released).toBe(true)
    expect(t.terminals.get('v')).toBeUndefined()
  })
})
