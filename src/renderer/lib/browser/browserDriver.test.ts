import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  webview: {
    getWebContentsId: vi.fn(() => 99),
    getURL: vi.fn(() => 'https://example.test/'),
    getTitle: vi.fn(() => 'Example'),
    isLoading: vi.fn(() => false),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    loadURL: vi.fn(),
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  browserControl: vi.fn(),
  emitAgentCursor: vi.fn(),
  emitBrowserContentChanged: vi.fn(),
  portalWebview: null as null | Record<string, unknown>,
  controller: null as null | {
    setViewport?: ReturnType<typeof vi.fn>
    newTab?: ReturnType<typeof vi.fn>
    listTabs?: ReturnType<typeof vi.fn>
    selectTab?: ReturnType<typeof vi.fn>
    closeTab?: ReturnType<typeof vi.fn>
  },
  resolvePanelLocation: vi.fn(),
  resizeNode: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      workspaces: [{
        id: 'workspace-1',
        panels: { 'browser-1': { id: 'browser-1', type: 'browser' } },
      }],
    }),
  },
}))
vi.mock('../activePanel', () => ({ getActivePanelId: () => 'browser-1' }))
vi.mock('../portalRegistry', () => ({
  portalRegistry: {
    get: () => h.portalWebview,
    getController: () => h.controller,
  },
}))
vi.mock('../workspace/canvasAccess', () => ({
  placementForBackgroundPanel: () => undefined,
  resolvePanelLocation: h.resolvePanelLocation,
  getCanvasOpsById: () => ({
    storeApi: {
      getState: () => ({
        nodeForPanel: () => 'node-1',
        resizeNode: h.resizeNode,
      }),
    },
  }),
}))
vi.mock('./agentCursor', () => ({
  emitAgentCursor: h.emitAgentCursor,
  emitBrowserContentChanged: h.emitBrowserContentChanged,
}))

import { handleBrowserMethod } from './browserDriver'

describe('browserDriver agent-browser boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.portalWebview = h.webview
    h.controller = null
    Object.assign(globalThis, {
      window: {
        electronAPI: { browserControl: h.browserControl },
      },
    })
  })

  it('forwards page observation to the single main-process engine', async () => {
    const snapshot = { snapshotId: 's1', refs: [], snapshot: '- document' }
    h.browserControl.mockResolvedValue({ result: snapshot })

    await expect(handleBrowserMethod('workspace-1', 'cate.browser.snapshot', { selector: 'main' }))
      .resolves.toEqual({ ok: true, result: snapshot })

    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'agentBrowser',
      webContentsId: 99,
      method: 'snapshot',
      args: { selector: 'main' },
    })
    expect('executeJavaScript' in h.webview).toBe(false)
  })

  it('forwards native command argv and shows activity before acting', async () => {
    h.browserControl.mockResolvedValue({ result: { clicked: true } })

    await expect(handleBrowserMethod('workspace-1', 'cate.browser.command', {
      command: ['click', '@s1e4'],
    })).resolves.toEqual({ ok: true, result: { clicked: true } })

    expect(h.emitAgentCursor).toHaveBeenCalledWith('browser-1', {
      kind: 'move',
      label: 'click @s1e4',
    })
    expect(h.browserControl).toHaveBeenCalledWith({
      op: 'agentBrowser',
      webContentsId: 99,
      method: 'command',
      args: { command: ['click', '@s1e4'] },
    })
    expect(h.emitBrowserContentChanged).toHaveBeenCalledWith('browser-1')
  })

  it('shows activity before the action and applies engine geometry afterward', async () => {
    h.browserControl.mockResolvedValue({
      result: { clicked: '@e1' },
      cursor: {
        kind: 'click',
        x: 50,
        y: 30,
        rect: [10, 10, 80, 40],
        label: 'click',
      },
    })

    await expect(handleBrowserMethod('workspace-1', 'cate.browser.click', { ref: '@s1e1' }))
      .resolves.toEqual({ ok: true, result: { clicked: '@e1' } })

    expect(h.emitAgentCursor).toHaveBeenNthCalledWith(1, 'browser-1', {
      kind: 'move',
      label: 'click',
    })
    expect(h.emitAgentCursor).toHaveBeenNthCalledWith(2, 'browser-1', {
      kind: 'click',
      x: 50,
      y: 30,
      rect: [10, 10, 80, 40],
      label: 'click',
    })
  })

  it('keeps panel-local navigation out of the automation daemon', async () => {
    await expect(handleBrowserMethod('workspace-1', 'cate.browser.current', {}))
      .resolves.toEqual({
        ok: true,
        result: {
          panelId: 'browser-1',
          url: 'https://example.test/',
          title: 'Example',
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      })
    expect(h.browserControl).not.toHaveBeenCalled()
  })

  it('opens a URL in a new tab instead of replacing the active tab', async () => {
    const replacement = {
      ...h.webview,
      getWebContentsId: vi.fn(() => 100),
      getURL: vi.fn(() => 'https://second.example/'),
    }
    const newTab = vi.fn(() => {
      h.portalWebview = null
      queueMicrotask(() => { h.portalWebview = replacement })
      return 'tab-2'
    })
    h.controller = { newTab }

    await expect(handleBrowserMethod('workspace-1', 'cate.browser.open', {
      url: 'https://second.example/',
      newTab: true,
    })).resolves.toEqual({
      ok: true,
      result: {
        panelId: 'browser-1',
        tabId: 'tab-2',
        url: 'https://second.example/',
      },
    })

    expect(newTab).toHaveBeenCalledWith('https://second.example/')
    expect(h.webview.loadURL).not.toHaveBeenCalled()
  })

  it('waits for a new tab to navigate and finish loading before returning', async () => {
    let url = 'about:blank'
    let loading = true
    const listeners = new Map<string, Set<(event: { url?: string }) => void>>()
    const replacement = {
      ...h.webview,
      getWebContentsId: vi.fn(() => 100),
      getURL: vi.fn(() => url),
      isLoading: vi.fn(() => loading),
      addEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      }),
      removeEventListener: vi.fn((type: string, listener: (event: { url?: string }) => void) => {
        listeners.get(type)?.delete(listener)
      }),
    }
    h.controller = {
      newTab: vi.fn(() => {
        h.portalWebview = null
        queueMicrotask(() => { h.portalWebview = replacement })
        return 'tab-2'
      }),
    }

    let settled = false
    const opened = handleBrowserMethod('workspace-1', 'cate.browser.open', {
      url: 'https://slow.example/',
      newTab: true,
    }).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(replacement.addEventListener).toHaveBeenCalled())
    expect(settled).toBe(false)

    url = 'https://slow.example/'
    for (const listener of listeners.get('did-navigate') ?? []) listener({ url })
    await Promise.resolve()
    expect(settled).toBe(false)

    loading = false
    for (const listener of listeners.get('did-stop-loading') ?? []) listener({})
    await expect(opened).resolves.toEqual({
      ok: true,
      result: { panelId: 'browser-1', tabId: 'tab-2', url: 'https://slow.example/' },
    })
  })

  it('waits for the selected tab guest before reporting success', async () => {
    const replacement = { ...h.webview, getWebContentsId: vi.fn(() => 100) }
    const listTabs = vi.fn(() => [
      { id: 'tab-1', url: 'https://one.example', title: 'One', active: true },
      { id: 'tab-2', url: 'https://two.example', title: 'Two', active: false },
    ])
    const selectTab = vi.fn(() => {
      h.portalWebview = null
      queueMicrotask(() => { h.portalWebview = replacement })
      return true
    })
    h.controller = { listTabs, selectTab }

    await expect(handleBrowserMethod('workspace-1', 'cate.browser.tabSelect', {
      tabId: 'tab-2',
    })).resolves.toEqual({
      ok: true,
      result: { tabId: 'tab-2' },
    })
    expect(h.portalWebview).toBe(replacement)
  })

  it('sets responsive viewport presets through the mounted panel controller', async () => {
    const setViewport = vi.fn()
    h.controller = { setViewport }

    await expect(handleBrowserMethod('workspace-1', 'cate.browser.viewport', {
      preset: 'mobile',
      width: 390,
      height: 844,
    })).resolves.toEqual({
      ok: true,
      result: { preset: 'mobile', width: 390, height: 844 },
    })

    expect(setViewport).toHaveBeenCalledWith({ preset: 'mobile', width: 390, height: 844 })
    expect(h.browserControl).not.toHaveBeenCalled()
  })

  it('resizes the browser canvas node without changing its page viewport', async () => {
    h.resolvePanelLocation.mockReturnValue({ kind: 'canvas', canvasPanelId: 'canvas-1' })

    await expect(handleBrowserMethod('workspace-1', 'cate.browser.resize', {
      width: 640,
      height: 480,
    })).resolves.toEqual({
      ok: true,
      result: { panelId: 'browser-1', width: 640, height: 480 },
    })

    expect(h.resizeNode).toHaveBeenCalledWith('node-1', { width: 640, height: 480 })
    expect(h.browserControl).not.toHaveBeenCalled()
  })
})
