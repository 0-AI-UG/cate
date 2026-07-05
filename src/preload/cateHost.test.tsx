// =============================================================================
// cateHost preload — verifies the `window.cate` shim shapes each call onto the
// CATE_HOST_INVOKE wire correctly: the guest identity (from the webview URL) and
// the per-method { method, args } payload the main-process dispatch expects. The
// panel test (kitchensinkPanel) mocks `window.cate` directly, so this is the one
// place the preload's own arg-mapping is exercised — the otherwise-untested layer
// between an extension calling cate.* and dispatchCateInvoke receiving it.
//
// .tsx so it runs under jsdom (needs window.location / history).
// =============================================================================

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const { invoke, exposeInMainWorld, on, removeListener } = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ ok: true })),
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}))

const IDENTITY = { extensionId: 'ext-1', workspaceId: 'ws-1', panelId: 'panel-1' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cate: any

beforeAll(async () => {
  // The preload reads identity from the webview URL's query string at import time.
  window.history.pushState({}, '', '/?cateExt=ext-1&cateWs=ws-1&catePanel=panel-1')
  await import('./cateHost')
  cate = exposeInMainWorld.mock.calls[0][1]
})

beforeEach(() => invoke.mockClear())

describe('cateHost preload — invoke wire contract', () => {
  it('exposes the cate global', () => {
    // (call history is cleared between tests; assert on the captured object.)
    expect(cate).toBeTypeOf('object')
    expect(cate.agent.send).toBeTypeOf('function')
  })

  it('agent.open maps a resume handle', async () => {
    await cate.agent.open({ resume: 'h-1' })
    expect(invoke).toHaveBeenCalledWith('cate:invoke', { ...IDENTITY, method: 'cate.agent.open', args: { resume: 'h-1' } })
  })

  it('agent.open with no opts sends resume undefined', async () => {
    await cate.agent.open()
    expect(invoke).toHaveBeenCalledWith('cate:invoke', { ...IDENTITY, method: 'cate.agent.open', args: { resume: undefined } })
  })

  it('agent.send carries { sessionId, prompt } in order', async () => {
    await cate.agent.send('s1', 'hello')
    expect(invoke).toHaveBeenCalledWith('cate:invoke', {
      ...IDENTITY,
      method: 'cate.agent.send',
      args: { sessionId: 's1', prompt: 'hello' },
    })
  })

  it('agent.dispose maps the sessionId', async () => {
    await cate.agent.dispose('s1')
    expect(invoke).toHaveBeenCalledWith('cate:invoke', { ...IDENTITY, method: 'cate.agent.dispose', args: { sessionId: 's1' } })
  })

  it('agent.run maps the prompt; cancel takes no args', async () => {
    await cate.agent.run('do it')
    expect(invoke).toHaveBeenCalledWith('cate:invoke', { ...IDENTITY, method: 'cate.agent.run', args: { prompt: 'do it' } })
    await cate.agent.cancel()
    expect(invoke).toHaveBeenCalledWith('cate:invoke', { ...IDENTITY, method: 'cate.agent.cancel', args: undefined })
  })
})

describe('cateHost preload — files.onDrop', () => {
  beforeEach(() => { on.mockClear(); removeListener.mockClear() })

  it('delivers files for this panel and ignores other topics/panels', () => {
    const seen: unknown[] = []
    const off = cate.files.onDrop((files: unknown) => seen.push(files))
    // The preload registered a cate:event listener; grab it.
    const [channel, listener] = on.mock.calls.at(-1) as [string, (...a: unknown[]) => void]
    expect(channel).toBe('cate:event')

    const dropped = [{ name: 'a.jsonl', path: '/a.jsonl', text: '{}', truncated: false }]
    listener({}, { panelId: 'panel-1', topic: 'files.drop', payload: { files: dropped } })
    expect(seen).toEqual([dropped])

    // Wrong panel and wrong topic are both ignored.
    listener({}, { panelId: 'other', topic: 'files.drop', payload: { files: dropped } })
    listener({}, { panelId: 'panel-1', topic: 'storage.change', payload: {} })
    expect(seen).toHaveLength(1)

    // A drop with no files array yields an empty list, not a throw.
    listener({}, { panelId: 'panel-1', topic: 'files.drop', payload: {} })
    expect(seen.at(-1)).toEqual([])

    off()
    expect(removeListener).toHaveBeenCalledWith('cate:event', listener)
  })
})
