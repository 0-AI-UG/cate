import vm from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ handler: undefined as any, windows: [] as any[] }))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  ipcMain: { handle: (_channel: string, handler: any) => { mocks.handler = handler } },
  BrowserWindow: class {
    destroyed = false
    webContents: any
    context: vm.Context
    constructor(public options: any) {
      mocks.windows.push(this)
      this.context = vm.createContext({ __cateBrowserBridge: { invoke: (raw: string) => mocks.handler({ sender: this.webContents, senderFrame: this.webContents.mainFrame }, raw) } })
      this.webContents = {
        mainFrame: {}, setWindowOpenHandler: vi.fn(), on: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } },
        debugger: { attach: vi.fn(), sendCommand: vi.fn(async (_method: string, params: any) => {
          if (_method === 'Runtime.releaseObjectGroup') return {}
          try {
            const expression = params.replMode ? `(async () => { ${params.expression}\n})()` : params.expression
            await vm.runInContext(expression, this.context)
            return {}
          } catch (error) { return { exceptionDetails: { text: String(error) } } }
        }) },
      }
    }
    async loadURL() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  },
}))

import { BrowserCodeSessions } from './browserCodeSession'
const observation = (id = 'o1', image = false) => ({ panelId: 'p1', tabId: 't1', observationId: id, documentId: 'd1', url: 'https://example.test', title: 'Example', viewport: {}, state: 'button Save', elements: [], diff: false, ...(image ? { screenshot: { mimeType: 'image/png', data: 'aGVsbG8=', width: 1, height: 1 } } : {}) })

beforeEach(() => { mocks.windows.length = 0 })
describe('browser code session', () => {
  it('keeps AX targeting and diff baselines separate from screenshot coordinates', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string, _args?: Record<string, unknown>) => {
      if (method.endsWith('getTab')) return { ...observation('ax1'), kind: 'ax' }
      if (method.endsWith('getScreenshot')) return { ...observation('image1', true), kind: 'image', elements: [], state: '' }
      return { action: 'click', observation: { ...observation('ax2'), kind: 'ax' } }
    })
    expect((await sessions.run('a', 'globalThis.tab = await cua.getTab({panelId:"p1"}); await tab.getScreenshot(); await tab.click(42)', invoke)).isError).toBeUndefined()
    expect(invoke.mock.calls[2][1]).toMatchObject({ target: 42, observationId: 'ax1' })
    invoke.mockClear()
    await sessions.run('a', 'await tab.getScreenshot(); await tab.click([40,40])', invoke)
    expect(invoke.mock.calls[0][1]).toMatchObject({ observationId: 'ax2' })
    expect(invoke.mock.calls[1][1]).toMatchObject({ target: [40, 40], observationId: 'image1' })
    invoke.mockClear()
    await sessions.run('a', 'await tab.getScreenshot(); await tab.getAXState()', invoke)
    expect(invoke.mock.calls[1][1]).toMatchObject({ observationId: 'ax2' })
    sessions.dispose()
  })

  it('invalidates old numeric authority when an image reveals navigation', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string, _args?: Record<string, unknown>) => method.endsWith('getTab') ? observation('ax1')
      : { ...observation('image2', true), kind: 'image', documentId: 'new-document', elements: [], state: '' })
    const result = await sessions.run('a', 'var tab = await cua.getTab({panelId:"p1"}); await tab.getScreenshot(); await tab.click(42)', invoke)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('AX observation')
    expect(invoke).toHaveBeenCalledTimes(2)
    sessions.dispose()
  })

  it('refreshes focused AX state before typing after an image-only observation', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string, _args?: Record<string, unknown>) => method.endsWith('getScreenshot')
      ? { ...observation('image1', true), kind: 'image', elements: [], state: '' }
      : { ...observation(method.endsWith('getTab') ? 'ax1' : 'ax2'), kind: 'ax' })
    await sessions.run('a', 'var tab = await cua.getTab({panelId:"p1"}); await tab.getScreenshot(); await tab.typeText("hello")', invoke)
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['cate.browser.getTab', 'cate.browser.getScreenshot', 'cate.browser.getAXState', 'cate.browser.typeText'])
    expect(invoke.mock.calls[3][1]).toMatchObject({ observationId: 'ax2' })
    sessions.dispose()
  })

  it('pins resolved tabs and carries fresh observation IDs across actions', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string) => method.endsWith('getTab') ? observation() : { action: 'click', observation: observation('o2') })
    const result = await sessions.run('a', 'var tab = await cua.getTab({panelId:"p1"}); await tab.click(42); await tab.setValue(17,"hello")', invoke)
    expect(result.isError).toBeUndefined()
    expect(invoke.mock.calls[1]).toEqual(['cate.browser.click', { panelId: 'p1', tabId: 't1', observationId: 'o1', target: 42 }])
    expect(invoke.mock.calls[2]).toEqual(['cate.browser.setValue', { panelId: 'p1', tabId: 't1', observationId: 'o2', target: 17, value: 'hello' }])
    expect(result.content).toHaveLength(3)
    expect(JSON.parse((result.content[1] as { text: string }).text)).toMatchObject({ action: 'click', observationId: 'o2' })
    expect(JSON.parse((result.content[1] as { text: string }).text)).not.toHaveProperty('elements')
    sessions.dispose()
  })

  it('observes a newly resolved binding before exposing it', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string) => method.endsWith('getTab') ? { panelId: 'p1', tabId: 't1' } : observation())
    const result = await sessions.run('a', 'await cua.getTab({panelId:"p1"})', invoke)
    expect(invoke.mock.calls).toEqual([['cate.browser.getTab', { panelId: 'p1' }], ['cate.browser.getAXState', { panelId: 'p1', tabId: 't1' }]])
    expect(result.content).toHaveLength(1)
    sessions.dispose()
  })

  it('cancels queued cells when a session resets', async () => {
    const sessions = new BrowserCodeSessions(20)
    const invoke = vi.fn()
    const first = sessions.run('a', 'await new Promise(() => {})', invoke)
    const queued = sessions.run('a', 'await cua.listTabs()', invoke)
    await first
    expect(JSON.stringify(await queued)).toContain('queued cell cancelled')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('bounds retained observations even when image output is suppressed', async () => {
    const sessions = new BrowserCodeSessions()
    let count = 0
    const invoke = vi.fn(async (method: string) => method.endsWith('getTab') ? observation()
      : { ...observation(`image${++count}`, true), kind: 'image', screenshot: { mimeType: 'image/png', data: 'a'.repeat(8_100_000), width: 1, height: 1 } })
    const result = await sessions.run('a', 'var tab = await cua.getTab({panelId:"p1"}); await tab.getScreenshot({emit:false}); await tab.getScreenshot({emit:false})', invoke)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Browser code retained observation limit exceeded')
    expect(result.content.every(item => item.type === 'text')).toBe(true)
    sessions.dispose()
  })

  it('replaces retained observation accounting and resets it between cells', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string) => method.endsWith('getTab') ? observation()
      : { ...observation('same-image', true), kind: 'image', screenshot: { mimeType: 'image/png', data: 'a'.repeat(8_100_000), width: 1, height: 1 } })
    const first = await sessions.run('a', 'globalThis.tab = await cua.getTab({panelId:"p1"}); await tab.getScreenshot({emit:false}); await tab.getScreenshot({emit:false})', invoke)
    expect(first.isError).toBeUndefined()
    const next = await sessions.run('a', 'await tab.getScreenshot({emit:false})', invoke)
    expect(next.isError).toBeUndefined()
    sessions.dispose()
  })

  it('allows a retained screenshot to be emitted without another retained-image copy', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string) => method.endsWith('getTab') ? observation()
      : { ...observation('image', true), kind: 'image', screenshot: { mimeType: 'image/png', data: 'a'.repeat(8_100_000), width: 1, height: 1 } })
    const result = await sessions.run('a', 'var tab = await cua.getTab({panelId:"p1"}); var result = await tab.getScreenshot({emit:false}); await nodeRepl.emitImage(result.screenshot)', invoke)
    expect(result.isError).toBeUndefined()
    expect(result.content.filter(item => item.type === 'image')).toHaveLength(1)
    sessions.dispose()
  })

  it('delivers actual image content and honors emit:false', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async (method: string) => observation(method.endsWith('getTab') ? 'o1' : 'o2', !method.endsWith('getTab')))
    const result = await sessions.run('a', 'var tab = await cua.getTab({panelId:"p1"}); await tab.getScreenshot({emit:false}); await tab.getAXStateAndScreenshot()', invoke)
    expect(result.content.map(item => item.type)).toEqual(['text', 'text', 'image'])
    expect(result.content[2]).toEqual({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' })
    sessions.dispose()
  })

  it('surfaces permission errors without dispatching further actions', async () => {
    const sessions = new BrowserCodeSessions()
    const invoke = vi.fn(async () => ({ error: 'Browser write permission required', recovery: 'Enable Browser Control' }))
    const result = await sessions.run('a', 'var tab = await cua.getTab({panelId:"p1"}); await tab.click(1)', invoke)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Browser write permission required')
    expect(JSON.stringify(result)).toContain('Enable Browser Control')
    expect(invoke).toHaveBeenCalledTimes(1)
    sessions.dispose()
  })

  it('rejects fabricated images and has no Node or timer capability', async () => {
    const sessions = new BrowserCodeSessions()
    const result = await sessions.run('a', 'await nodeRepl.write([typeof process,typeof require,typeof setTimeout]); await nodeRepl.emitImage({data:"forged"})', vi.fn())
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: '["undefined","undefined","undefined"]' })
    expect(JSON.stringify(result)).toContain('Only browser observation images')
    expect(mocks.windows[0].options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true })
    expect(mocks.windows[0].options.webPreferences.partition).not.toMatch(/^persist:/)
    sessions.dispose()
  })

  it('preserves emitted diagnostics when the code times out', async () => {
    const sessions = new BrowserCodeSessions(20)
    const result = await sessions.run('a', 'await nodeRepl.write("before timeout"); await new Promise(() => {})', vi.fn())
    expect(result.isError).toBe(true)
    expect(result.content[0]).toEqual({ type: 'text', text: 'before timeout' })
    expect(JSON.stringify(result.content[1])).toContain('timed out')
  })

  it('releases cell result handles without resetting the session', async () => {
    const sessions = new BrowserCodeSessions()
    await sessions.run('a', '({large: true})', vi.fn())
    const commands = mocks.windows[0].webContents.debugger.sendCommand.mock.calls
    const evaluation = commands.find((call: any[]) => call[1]?.replMode)
    expect(evaluation[1].objectGroup).toEqual(expect.any(String))
    expect(commands).toContainEqual(['Runtime.releaseObjectGroup', { objectGroup: evaluation[1].objectGroup }])
    expect(mocks.windows[0].destroyed).toBe(false)
    sessions.dispose()
  })

  it('resets timed-out sessions and rejects late RPCs', async () => {
    const sessions = new BrowserCodeSessions(20)
    const result = await sessions.run('a', 'await new Promise(() => {})', vi.fn())
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('timed out')
    const oldWindow = mocks.windows[0]
    expect(oldWindow.destroyed).toBe(true)
    await expect(mocks.handler({ sender: oldWindow.webContents, senderFrame: oldWindow.webContents.mainFrame }, '{}')).rejects.toThrow('Unregistered')
  })

  it('rejects other frames and unawaited work', async () => {
    const sessions = new BrowserCodeSessions()
    const result = await sessions.run('a', 'cua.listTabs()', () => new Promise(() => {}))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Await every browser call')
    expect(mocks.windows[0].destroyed).toBe(true)
    await expect(mocks.handler({ sender: {}, senderFrame: {} }, '{}')).rejects.toThrow('Unregistered')
  })
})
