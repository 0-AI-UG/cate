import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  panel: {
    id: 'browser-1', type: 'browser' as const, title: 'Browser', isDirty: false,
    tabs: [{ id: 'tab-1', url: 'https://example.test/', title: 'Example' }], activeTabId: 'tab-1',
  },
  webview: {
    getWebContentsId: vi.fn(() => 99), getURL: vi.fn(() => 'https://example.test/'), getTitle: vi.fn(() => 'Example'),
    isLoading: vi.fn(() => false), canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false),
    loadURL: vi.fn(), reload: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  },
  browserControl: vi.fn(), emitAgentCursor: vi.fn(), setViewport: vi.fn(), resizeNode: vi.fn(), resolvePanelLocation: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: [{ id: 'workspace-1', panels: { 'browser-1': h.panel } }] }) },
}))
vi.mock('../activePanel', () => ({ getActivePanelId: () => 'browser-1' }))
vi.mock('../portalRegistry', () => ({
  portalRegistry: {
    get: () => h.webview,
    getController: () => ({ setViewport: h.setViewport, listTabs: () => h.panel.tabs.map((tab) => ({ ...tab, active: true })) }),
  },
}))
vi.mock('../workspace/canvasAccess', () => ({
  placementForBackgroundPanel: () => undefined,
  resolvePanelLocation: h.resolvePanelLocation,
  getCanvasOpsById: () => ({ storeApi: { getState: () => ({ nodeForPanel: () => 'node-1', resizeNode: h.resizeNode }) } }),
}))
vi.mock('./agentCursor', () => ({ emitAgentCursor: h.emitAgentCursor }))

import { handleBrowserMethod } from './browserDriver'

describe('browserDriver target-bound webview boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.browserControl.mockImplementation(async (request: { op: string }) => request.op === 'attach'
      ? { ok: true }
      : { result: { clicked: true } })
    Object.assign(globalThis, { window: { electronAPI: { browserControl: h.browserControl } } })
  })

  it('attaches and executes against the exact guest without reading DOM focus', async () => {
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.command', {
      panelId: 'browser-1', command: ['click', '#submit'],
    })).resolves.toEqual({ ok: true, result: { clicked: true } })
    expect(h.browserControl).toHaveBeenNthCalledWith(1, {
      op: 'attach', webContentsId: 99, workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1',
    })
    expect(h.browserControl).toHaveBeenNthCalledWith(2, {
      op: 'execute', webContentsId: 99, workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1',
      method: 'command', args: { panelId: 'browser-1', command: ['click', '#submit'] },
    })
  })

  it('keeps navigation in the mounted webview layer', async () => {
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.current', {})).resolves.toMatchObject({
      ok: true, result: { panelId: 'browser-1', url: 'https://example.test/' },
    })
    expect(h.browserControl).not.toHaveBeenCalled()
  })

  it('changes responsive viewport through the panel controller', async () => {
    let settle!: () => void
    h.setViewport.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve }))
    let completed = false
    const request = handleBrowserMethod('workspace-1', 'cate.browser.viewport', {
      preset: 'mobile', width: 390, height: 844,
    }).then((result) => { completed = true; return result })
    await Promise.resolve()
    expect(completed).toBe(false)
    settle()
    await expect(request).resolves.toEqual({ ok: true, result: { preset: 'mobile', width: 390, height: 844 } })
    expect(h.setViewport).toHaveBeenCalledWith({ preset: 'mobile', width: 390, height: 844 })
  })

  it('resizes the canvas card without changing the page viewport', async () => {
    h.resolvePanelLocation.mockReturnValue({ kind: 'canvas', canvasPanelId: 'canvas-1' })
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.resize', {
      width: 640, height: 480,
    })).resolves.toEqual({ ok: true, result: { panelId: 'browser-1', width: 640, height: 480 } })
    expect(h.resizeNode).toHaveBeenCalledWith('node-1', { width: 640, height: 480 })
  })
})
