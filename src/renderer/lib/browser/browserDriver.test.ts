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
  newTab: vi.fn(), browserControl: vi.fn(), emitAgentCursor: vi.fn(), setViewport: vi.fn(), resizeNode: vi.fn(), resolvePanelLocation: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: { getState: () => ({ workspaces: [{ id: 'workspace-1', panels: { 'browser-1': h.panel } }] }) },
}))
vi.mock('../activePanel', () => ({ getActivePanelId: () => 'browser-1' }))
vi.mock('../portalRegistry', () => ({
  portalRegistry: {
    get: () => h.webview,
    getController: () => ({ newTab: h.newTab, setViewport: h.setViewport, listTabs: () => h.panel.tabs.map((tab) => ({ ...tab, active: true })) }),
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
    h.newTab.mockReset()
    h.panel.activeTabId = 'tab-1'
    h.browserControl.mockImplementation(async (request: { op: string }) => request.op === 'attach'
      ? { ok: true }
      : { result: { clicked: true } })
    Object.assign(globalThis, { window: { electronAPI: { browserControl: h.browserControl } } })
  })

  it('attaches and executes against the exact guest without reading DOM focus', async () => {
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.click', {
      panelId: 'browser-1', tabId: 'tab-1', observationId: 'o1', target: 42,
    })).resolves.toEqual({ ok: true, result: { clicked: true } })
    expect(h.browserControl).toHaveBeenNthCalledWith(1, {
      op: 'attach', webContentsId: 99, workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1',
    })
    expect(h.browserControl).toHaveBeenNthCalledWith(2, {
      op: 'execute', webContentsId: 99, workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1',
      method: 'click', args: { panelId: 'browser-1', tabId: 'tab-1', observationId: 'o1', target: 42 },
    })
  })

  it('rejects missing and stale bindings before attaching a guest', async () => {
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.click', { panelId: 'browser-1', target: 42 })).resolves.toEqual({ ok: false, error: 'tabId-required' })
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.click', { panelId: 'browser-1', tabId: 'another', target: 42 })).resolves.toEqual({ ok: false, error: 'browser-tab-changed' })
    expect(h.browserControl).not.toHaveBeenCalled()
  })

  it('cancels an action if the active tab changes while attachment is pending', async () => {
    h.browserControl.mockImplementationOnce(async () => {
      h.panel = { ...h.panel, activeTabId: 'tab-2' }
      return { ok: true }
    })
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.click', {
      panelId: 'browser-1', tabId: 'tab-1', observationId: 'o1', target: 42,
    })).resolves.toMatchObject({ ok: false, error: 'browser-tab-changed' })
    expect(h.browserControl).toHaveBeenCalledTimes(1)
  })

  it('keeps navigation in the mounted webview layer', async () => {
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.getTab', {})).resolves.toMatchObject({
      ok: true, result: { panelId: 'browser-1', url: 'https://example.test/' },
    })
    expect(h.browserControl).not.toHaveBeenCalled()
  })

  it('changes responsive viewport through the panel controller', async () => {
    let settle!: () => void
    h.setViewport.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve }))
    let completed = false
    const request = handleBrowserMethod('workspace-1', 'cate.browser.setViewport', {
      tabId: 'tab-1', preset: 'mobile', width: 390, height: 844,
    }).then((result) => { completed = true; return result })
    await vi.waitFor(() => expect(h.setViewport).toHaveBeenCalled())
    expect(completed).toBe(false)
    settle()
    await expect(request).resolves.toEqual({ ok: true, result: { preset: 'mobile', width: 390, height: 844, observation: { clicked: true } } })
    expect(h.setViewport).toHaveBeenCalledWith({ preset: 'mobile', width: 390, height: 844 })
  })

  it('resizes the canvas card without changing the page viewport', async () => {
    h.resolvePanelLocation.mockReturnValue({ kind: 'canvas', canvasPanelId: 'canvas-1' })
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.resize', {
      tabId: 'tab-1', width: 640, height: 480,
    })).resolves.toEqual({ ok: true, result: { panelId: 'browser-1', width: 640, height: 480 } })
    expect(h.resizeNode).toHaveBeenCalledWith('node-1', { width: 640, height: 480 })
  })

  it.each(['getTab', 'createTab'])('rejects a tab switch while %s is waiting for readiness', async method => {
    const createdId = 'tab-created'
    h.newTab.mockImplementationOnce(() => {
      h.panel = { ...h.panel, activeTabId: createdId }
      h.webview = { ...h.webview }
      return createdId
    })
    h.webview.isLoading.mockImplementationOnce(() => {
      h.panel = { ...h.panel, activeTabId: 'tab-other' }
      return false
    })
    await expect(handleBrowserMethod('workspace-1', `cate.browser.${method}`, {
      panelId: 'browser-1', tabId: 'tab-1',
    })).resolves.toMatchObject({ ok: false, error: 'browser-tab-changed' })
  })

  it('cancels a viewport mutation if its code cell ends while the guest is loading', async () => {
    let cancelled = false
    h.browserControl.mockImplementation(async () => cancelled ? { error: 'browser-code-cell-cancelled' } : { ok: true })
    h.webview.isLoading.mockImplementationOnce(() => { cancelled = true; return false })
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.setViewport', {
      panelId: 'browser-1', tabId: 'tab-1', _codeCellId: 'cell', width: 390, height: 844,
    })).rejects.toThrow('browser-code-cell-cancelled')
    expect(h.setViewport).not.toHaveBeenCalled()
  })
})
