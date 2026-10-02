import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Subscription } from '@kernel/rpc/contract'
import { setRuntimeResolver } from '@kernel/rpc/client'
import { installMockClientUi } from '@kernel/ui/testing'
import type { PanelViewProps } from '@client/host'
import type { SessionHandle } from '@client/connections'
import { FILE_REFS_MIME } from '@workspace/files/contract'
import type { TerminalOp, TerminalSnapshot } from '../contract/types'

const WS = 'ws'

const xterms = vi.hoisted(() => [] as FakeTerminal[])

interface FakeTerminal {
  cols: number
  rows: number
  options: Record<string, unknown>
  element?: HTMLElement
  textarea?: HTMLTextAreaElement
  written: string[]
  pasted: string[]
  data: Set<(data: string) => void>
  disposed: boolean
  focus: () => void
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    element?: HTMLElement
    textarea?: HTMLTextAreaElement
    written: string[] = []
    pasted: string[] = []
    data = new Set<(data: string) => void>()
    disposed = false
    buffer = { active: { viewportY: 0, baseY: 0, getLine: () => undefined } }
    parser = { registerOscHandler: () => ({ dispose() {} }) }
    focus = vi.fn()
    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      xterms.push(this as unknown as FakeTerminal)
    }
    open(parent: HTMLElement) {
      this.element = document.createElement('div')
      this.textarea = document.createElement('textarea')
      this.element.appendChild(this.textarea)
      parent.appendChild(this.element)
    }
    loadAddon() {}
    registerLinkProvider() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    write(data: string | Uint8Array, cb?: () => void) {
      this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      cb?.()
    }
    reset() { this.written = [] }
    paste(text: string) { this.pasted.push(text) }
    input(data: string) { for (const l of this.data) l(data) }
    onData(l: (data: string) => void) { this.data.add(l); return { dispose: () => this.data.delete(l) } }
    onResize() { return { dispose() {} } }
    resize(cols: number, rows: number) { this.cols = cols; this.rows = rows }
    refresh() {}
    scrollToBottom() {}
    dispose() { this.disposed = true }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return undefined } } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext = vi.fn(); findPrevious = vi.fn(); clearDecorations = vi.fn() } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
// The host's chrome context is the host's concern; the view only claims a corner.
vi.mock('@client/host', () => ({ useClaimPanelCorner: () => {} }))
const files = vi.hoisted(() => ({ localize: vi.fn(async (refs: Array<{ path: string }>) => refs.map((ref) => ref.path)) }))
vi.mock('@workspace/files/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workspace/files/client')>()),
  fileRefs: { localize: files.localize, upload: vi.fn(), transfer: vi.fn(), readBytes: vi.fn() },
}))
vi.mock('@xterm/addon-webgl', () => { throw new Error('no WebGL in jsdom') })

import TerminalView from './TerminalView'

function fakeProcess() {
  const attaches: Array<{ id: string; written: Uint8Array[]; cancelled: boolean; events: Set<(e: unknown) => void> }> = []
  const proxy = {
    attach: vi.fn((params: { id: string }) => {
      const entry = { id: params.id, written: [] as Uint8Array[], cancelled: false, events: new Set<(e: unknown) => void>() }
      attaches.push(entry)
      const sub = {
        onEvent: (l: (e: unknown) => void) => { entry.events.add(l); return () => entry.events.delete(l) },
        onBytes: () => () => {},
        write: (bytes: Uint8Array) => { entry.written.push(bytes) },
        ack: () => {},
        cancel: () => { entry.cancelled = true },
        done: new Promise(() => {}),
      }
      return sub as unknown as Subscription<unknown, unknown>
    }),
    view: vi.fn(async () => {}),
  }
  return { proxy, attaches }
}

const snapshotOf = (patch: Partial<TerminalSnapshot> = {}): TerminalSnapshot => ({
  ptyId: 'pty-1', status: 'running', title: 'zsh', cwd: '/repo', activity: { type: 'idle' },
  agent: null, exitCode: null, error: null, ...patch,
})

function props(snapshot: TerminalSnapshot | null, send = vi.fn(async (_op: TerminalOp) => undefined)): PanelViewProps<TerminalSnapshot, TerminalOp> {
  const session = {
    panelId: 'p1', getSnapshot: () => null, subscribe: () => () => {}, send, write: vi.fn(),
    onBytes: () => () => {}, release: vi.fn(),
  } as unknown as SessionHandle<TerminalSnapshot>
  return {
    workspaceId: 'ws', panelId: 'p1', record: { id: 'p1', type: 'terminal', title: 'Terminal 1', fields: {} },
    session, send, snapshot, visible: true, focused: false,
  }
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let process_: ReturnType<typeof fakeProcess>
let restore: () => void
let host: HTMLDivElement
let root: Root

const render = (element: ReactElement) => { act(() => root.render(element)) }
const q = (selector: string) => host.querySelector(selector)
const dispatch = (target: Element, event: Event) => { act(() => { target.dispatchEvent(event) }) }
const buttonWithText = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!

beforeEach(() => {
  xterms.length = 0
  installMockClientUi({ promptLinkOpen: vi.fn(async () => 'cancel' as const), confirmCloseTerminal: vi.fn(async () => 'close' as const) })
  process_ = fakeProcess()
  restore = setRuntimeResolver((id) => (id === 'ws' ? ({ process: process_.proxy } as never) : null))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  restore()
})

describe('TerminalView', () => {
  it('attaches to the session PTY and writes the screen it gets', () => {
    render(<TerminalView {...props(snapshotOf())} />)
    expect(process_.attaches.map((a) => a.id)).toEqual(['pty-1'])
    act(() => { for (const l of process_.attaches[0].events) l({ kind: 'screen', viewer: 'v1', data: 'hello', cols: 80, rows: 24 }) })
    expect(xterms[0].written).toEqual(['hello'])
    // Keystrokes go straight to the attach stream.
    act(() => { for (const l of xterms[0].data) l('ls\r') })
    expect(new TextDecoder().decode(process_.attaches[0].written[0])).toBe('ls\r')
  })

  it('re-attaches when the session spawns a new PTY and stays detached without one', () => {
    render(<TerminalView {...props(snapshotOf({ ptyId: null, status: 'starting' }))} />)
    expect(process_.attaches).toHaveLength(0)
    render(<TerminalView {...props(snapshotOf({ ptyId: 'pty-1' }))} />)
    render(<TerminalView {...props(snapshotOf({ ptyId: 'pty-2' }))} />)
    expect(process_.attaches.map((a) => [a.id, a.cancelled])).toEqual([['pty-1', true], ['pty-2', false]])
    act(() => root.unmount())
    root = createRoot(host)
    expect(process_.attaches[1].cancelled).toBe(true)
    expect(xterms[0].disposed).toBe(true)
  })

  it('shows a failed start and restarts on Retry', async () => {
    const send = vi.fn(async (_op: TerminalOp) => undefined)
    render(<TerminalView {...props(snapshotOf({ ptyId: null, status: 'failed', error: 'workspace is not trusted' }), send)} />)
    expect(host.textContent).toContain('workspace is not trusted')
    dispatch(buttonWithText('Retry'), new MouseEvent('click', { bubbles: true }))
    expect(send).toHaveBeenCalledWith({ kind: 'restart' })
  })

  it('opens search on Cmd/Ctrl+F and closes it on Escape', () => {
    render(<TerminalView {...props(snapshotOf())} />)
    dispatch(host.firstElementChild!, new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    const input = q('input[placeholder="Search terminal..."]')!
    expect(input).toBeTruthy()
    dispatch(input, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(q('input[placeholder="Search terminal..."]')).toBeNull()
  })

  const dropRefs = (refs: Array<{ workspaceId: string; path: string }>) => {
    const data: Record<string, string> = { [FILE_REFS_MIME]: JSON.stringify({ refs }) }
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { types: Object.keys(data), getData: (f: string) => data[f] ?? '' } })
    dispatch(q('[data-filedrop="terminal"]')!, drop)
  }

  it('pastes files of its own workspace as shell-escaped paths', async () => {
    render(<TerminalView {...props(snapshotOf())} />)
    await act(async () => dropRefs([{ workspaceId: WS, path: '/repo/a b.ts' }]))
    expect(xterms[0].pasted).toEqual(["'/repo/a b.ts'"])
    expect(files.localize).toHaveBeenCalledWith([{ workspaceId: WS, path: '/repo/a b.ts' }], { workspaceId: WS, near: '/repo' })
  })

  it('pastes the copy of a file from another workspace, made next to its cwd', async () => {
    files.localize.mockResolvedValueOnce(['/repo/.cate/tmp/b.ts'])
    render(<TerminalView {...props(snapshotOf({ cwd: '/repo/src' }))} />)
    await act(async () => dropRefs([{ workspaceId: 'other', path: '/elsewhere/b.ts' }]))
    expect(files.localize).toHaveBeenCalledWith([{ workspaceId: 'other', path: '/elsewhere/b.ts' }], { workspaceId: WS, near: '/repo/src' })
    expect(xterms[0].pasted).toEqual(['/repo/.cate/tmp/b.ts'])
  })
})

describe('confirmCloseTerminals', () => {
  it('asks only when a program runs', async () => {
    const { confirmCloseTerminals } = await import('./confirmClose')
    const ui = installMockClientUi({ confirmCloseTerminal: vi.fn(async () => 'cancel' as const) })
    await expect(confirmCloseTerminals([snapshotOf()])).resolves.toBe(true)
    expect(ui.confirmCloseTerminal).not.toHaveBeenCalled()
    await expect(confirmCloseTerminals([snapshotOf({ activity: { type: 'running', processName: 'npm' } })])).resolves.toBe(false)
    expect(ui.confirmCloseTerminal).toHaveBeenCalledWith({ count: 1, processName: 'npm' })
  })

  it('guards a close with the first snapshot of a freshly opened channel', async () => {
    const { terminalCloseGuard } = await import('./confirmClose')
    const ui = installMockClientUi({ confirmCloseTerminal: vi.fn(async () => 'close' as const) })
    let state: { rev: number; snapshot: TerminalSnapshot } | null = null
    const listeners = new Set<() => void>()
    const session = {
      getSnapshot: () => state,
      subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) },
    } as unknown as SessionHandle
    const answer = terminalCloseGuard({ workspaceId: 'ws', record: props(null).record, session, closing: new Set(['p1']) })
    state = { rev: 0, snapshot: snapshotOf({ activity: { type: 'running', processName: 'vim' } }) }
    for (const l of listeners) l()
    await expect(answer).resolves.toBe(true)
    expect(ui.confirmCloseTerminal).toHaveBeenCalledWith({ count: 1, processName: 'vim' })
  })
})
