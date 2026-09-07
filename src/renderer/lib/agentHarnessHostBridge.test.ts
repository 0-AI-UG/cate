import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentHarnessHostBridgeScript } from './agentHarnessHostBridge'

function guest() {
  const messages: any[] = []
  const control: any = { setAttribute: vi.fn() }
  const open = vi.fn(), close = vi.fn(), toggle = vi.fn(), toggleVisibility = vi.fn()
  let state: any = { open, close, toggle, toggleVisibility }
  const window: any = { __cateChat: {
    threadRef: { threadId: 'thread' },
    store: { getState: () => state, setState: (patch: any) => { state = { ...state, ...patch } } },
    openAgents: () => state.open({ threadId: 'thread' }, 'agents'),
    closeAgents: () => state.close({ threadId: 'thread' }),
  } }
  runInNewContext(agentHarnessHostBridgeScript('token'), {
    window, crypto: { randomUUID: () => String(messages.length) },
    setTimeout, clearTimeout,
    console: { info: (message: string) => messages.push(JSON.parse(message.slice('cate-chat-host:'.length))) },
    document: { addEventListener: vi.fn(), createElement: () => control, body: { append: vi.fn() }, documentElement: {} },
    MutationObserver: class { observe() {} },
  })
  return { window, state: () => state, open, close, toggle, toggleVisibility, control, messages }
}

describe('embedded chat host bridge', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('settles pending placement requests when the host binding is disposed', async () => {
    const g = guest()
    const pending = g.window.__cateHost.request('place-agent', {})
    const assertion = expect(pending).rejects.toThrow('Conversation changed')
    g.window.__cateHost.cancelPending()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds requests that never receive a reply', async () => {
    const g = guest()
    const pending = g.window.__cateHost.request('place-agent', {})
    const assertion = expect(pending).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(120000)
    await assertion
  })
  it('keeps subagent controls in T3 and routes every diff/file entry point to Cate', () => {
    const g = guest()
    g.window.__cateChat.openAgents()
    expect(g.open).toHaveBeenCalledWith({ threadId: 'thread' }, 'agents')
    g.window.__cateChat.closeAgents()
    expect(g.close).toHaveBeenCalledTimes(2)
    g.state().toggle({ threadId: 'thread' }, 'agents')
    expect(g.open).toHaveBeenCalledTimes(2)
    expect(g.toggle).not.toHaveBeenCalled()
    expect(g.state().close).toBe(g.close)
    g.state().toggleVisibility({ threadId: 'thread' })
    expect(g.close).toHaveBeenCalledTimes(3)
    expect(g.toggleVisibility).not.toHaveBeenCalled()
    expect(g.control.onclick).toBeUndefined()
    g.state().open({ threadId: 'thread' }, 'diff')
    g.state().openFile({ threadId: 'thread' }, 'src/index.ts')
    expect(g.messages.map((m) => [m.action, m.payload])).toEqual([
      ['diff', { threadId: 'thread' }], ['file', { threadId: 'thread', filePath: 'src/index.ts' }],
    ])
    g.state().open({ threadId: 'thread' }, 'files')
    expect(g.open).toHaveBeenCalledTimes(2)
  })

  it('blocks workspace shortcuts while keeping model and chat shortcuts', () => {
    const g = guest()
    for (const command of ['terminal.new', 'terminal.toggle', 'terminal.split']) expect(g.window.__cateHost.shortcut(command)).toBe(true)
    expect(g.window.__cateHost.shortcut('rightPanel.toggleMaximized')).toBe(true)
    expect(g.window.__cateHost.shortcut('modelPicker.toggle')).toBe(false)
    expect(g.window.__cateHost.shortcut('rightPanel.toggle')).toBe(true)
    expect(g.window.__cateHost.shortcut('thread.copyReference')).toBe(false)
    expect(g.window.__cateHost.shortcut('diff.toggle')).toBe(true)
    expect(g.messages.at(-1).action).toBe('diff')
  })

  it('waits for placement, propagates cancellation, and rejects failed handoffs', async () => {
    const g = guest()
    const first = g.window.__cateHost.request('place-agent', {})
    g.window.__cateHost.reply(g.messages[0].id, null)
    expect(await first).toBeNull()
    const second = g.window.__cateHost.request('open-agent', { threadId: 'new' })
    g.window.__cateHost.reply(g.messages[1].id, null, 'Panel closed')
    await expect(second).rejects.toThrow('Panel closed')
  })
})
