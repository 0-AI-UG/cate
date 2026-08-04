import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  })
})

const portalMocks = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
  registerController: vi.fn(),
  unregisterController: vi.fn(),
}))

vi.mock('../lib/portalRegistry', () => ({ portalRegistry: portalMocks }))
vi.mock('../ui/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./UrlSuggestions', () => ({ UrlSuggestions: () => null }))
vi.mock('./StartPage', () => ({ StartPage: () => <div>Start page</div> }))
vi.mock('./BrowserMenu', () => ({
  BrowserMenu: ({ onOpenPasswordManager, onZoomOut, onZoomReset, zoomPercent }: {
    onOpenPasswordManager: () => void
    onZoomOut: () => void
    onZoomReset: () => void
    zoomPercent: number
  }) => (
    <>
      <button onClick={onOpenPasswordManager}>Open password manager</button>
      <button onClick={onZoomOut}>Zoom out</button>
      <button onClick={onZoomReset}>Reset zoom ({zoomPercent}%)</button>
    </>
  ),
}))
vi.mock('./BrowserPasswordManagerPage', () => ({
  BrowserPasswordManagerPage: () => <div>Password manager page</div>,
}))
vi.mock('./BrowserTabStrip', () => ({ BrowserTabStrip: () => <div data-testid="browser-tab-strip" /> }))
vi.mock('./BrowserBookmarksSidebar', () => ({ BrowserBookmarksSidebar: () => null }))

import BrowserPanel, { browserNativeZoomFactor, browserViewportScale } from './BrowserPanel'
import { useAppStore } from '../stores/appStore'
import { useBrowserStore } from '../stores/browserStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { BrowserViewEvent, BrowserViewState } from '../../shared/electron-api'
import type { BrowserTab } from '../../shared/types'
import { emitBrowserContentChanged } from '../lib/browser/agentCursor'

const initialAppState = useAppStore.getState()
const initialBrowserState = useBrowserStore.getState()
const initialSettingsState = useSettingsStore.getState()

const updatePanelTitle = vi.fn()
const updateBrowserActiveTabUrl = vi.fn()
const updatePanelTabs = vi.fn()
const recordVisit = vi.fn()
const unsubscribeShortcut = vi.fn()
const onBrowserShortcut = vi.fn(() => unsubscribeShortcut)
const browserSetProxy = vi.fn<(partition: string, proxyUrl: string) => Promise<void>>(async () => undefined)
const browserControl = vi.fn(async () => ({ ok: true }))
const browserCredentialSuggestions = vi.fn(async () => ({
  suggestions: [{ id: 'credential-1', username: 'person@example.com', origin: 'https://initial.example' }],
}))
const browserCredentialFill = vi.fn(async () => ({ ok: true }))
const browserViewCreate = vi.fn()
const browserViewCommand = vi.fn()
const browserViewDestroy = vi.fn(async () => undefined)
const browserViewSetBounds = vi.fn()

let browserViewEventCallback: ((event: BrowserViewEvent) => void) | null = null
let nextWebContentsId = 41
let nativeState: BrowserViewState
let host: HTMLDivElement
let root: Root

function mount(options?: { tabs?: BrowserTab[]; activeTabId?: string }): void {
  const tabs = options?.tabs ?? [{ id: 'tab-1', url: 'https://initial.example', title: 'Initial' }]
  act(() => {
    root.render(
      <BrowserPanel
        panelId="browser-1"
        workspaceId="ws-1"
        nodeId="node-1"
        tabs={tabs}
        activeTabId={options?.activeTabId ?? tabs[0].id}
      />,
    )
  })
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

function emit(type: BrowserViewEvent['type'], fields: Partial<BrowserViewEvent> = {}): void {
  if (fields.url) nativeState.url = fields.url
  if (fields.title) nativeState.title = fields.title
  if (type === 'did-start-loading') nativeState.loading = true
  if (type === 'did-stop-loading' || type === 'did-fail-load') nativeState.loading = false
  act(() => browserViewEventCallback?.({
    panelId: 'browser-1',
    webContentsId: nativeState.webContentsId,
    type,
    ...fields,
  }))
}

function placeholder(): HTMLElement {
  const element = host.querySelector<HTMLElement>('[data-browser-native-view]')
  if (!element) throw new Error('native browser placeholder not mounted')
  return element
}

beforeEach(() => {
  vi.clearAllMocks()
  nextWebContentsId = 41
  nativeState = {
    webContentsId: nextWebContentsId,
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: true,
    canGoForward: false,
  }
  browserViewCreate.mockImplementation(async () => {
    nativeState = { ...nativeState, webContentsId: nextWebContentsId++ }
    return { ...nativeState }
  })
  browserViewCommand.mockImplementation(async (_panelId, _webContentsId, command) => {
    if (command.op === 'getState') return { ...nativeState }
    if (command.op === 'loadURL') nativeState.url = command.url
    return command.op === 'capturePage' ? null : undefined
  })

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useAppStore.setState({ updatePanelTitle, updateBrowserActiveTabUrl, updatePanelTabs })
  useBrowserStore.setState({
    bookmarks: [], recordVisit, toggleBookmark: vi.fn(), querySuggestions: vi.fn(() => []),
  })
  useSettingsStore.setState({
    browserHomepage: 'https://home.example',
    browserSearchEngine: 'google',
    browserProxyUrl: '',
    browserNewTabBehavior: 'startPage',
    browserShowTabSidebar: false,
    setSetting: vi.fn(),
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    onBrowserShortcut,
    onBrowserViewEvent: (callback: (event: BrowserViewEvent) => void) => {
      browserViewEventCallback = callback
      return vi.fn()
    },
    browserViewCreate,
    browserViewCommand,
    browserViewDestroy,
    browserViewSetBounds,
    browserSetProxy,
    browserControl,
    browserCredentialSuggestions,
    browserCredentialFill,
    browserCredentialProfiles: vi.fn(async () => ({
      directImportSupported: false, secureStorageAvailable: true, profiles: [], importedCount: 0,
    })),
    browserCredentialList: vi.fn(async () => []),
    webviewScreenshot: vi.fn(async () => null),
    browserClearData: vi.fn(async () => undefined),
    showContextMenu: vi.fn(async () => null),
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppState, true)
  useBrowserStore.setState(initialBrowserState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('BrowserPanel component', () => {
  it('uses a main-owned native browser surface and keeps viewport scale math', async () => {
    mount()
    await flush()

    expect(browserViewCreate).toHaveBeenCalledWith({ panelId: 'browser-1', partition: 'persist:browser-shared' })
    expect(placeholder().dataset.browserSrc).toBe('https://initial.example')
    expect(browserViewportScale(
      { preset: 'desktop', width: 1280, height: 800 },
      { width: 800, height: 500 },
    )).toBe(0.625)
    expect(browserNativeZoomFactor(0.9, 0.625, 0.8)).toBeCloseTo(0.45)
  })

  it('does not poll native layout while the browser is idle', async () => {
    let nextFrameId = 1
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    mount()
    await flush()

    for (let pass = 0; pass < 5 && frames.size > 0; pass += 1) {
      const batch = [...frames.values()]
      frames.clear()
      act(() => batch.forEach((callback) => callback(performance.now())))
      await flush()
    }

    expect(frames.size).toBe(0)
  })

  it('captures a preview only when renderer chrome must cover the native view', async () => {
    browserViewCommand.mockImplementation(async (_panelId, _webContentsId, command) => {
      if (command.op === 'getState') return { ...nativeState }
      if (command.op === 'loadURL') nativeState.url = command.url
      return command.op === 'capturePage' ? 'data:image/jpeg;base64,preview' : undefined
    })
    mount()
    await flush()
    emit('did-stop-loading')
    await flush()
    expect(browserViewCommand).not.toHaveBeenCalledWith(
      'browser-1',
      41,
      { op: 'capturePage' },
    )

    act(() => { (host.querySelector('button[aria-label="Browser menu"]') as HTMLButtonElement).click() })
    await flush()
    expect(browserViewCommand).toHaveBeenCalledWith('browser-1', 41, { op: 'capturePage' })

    browserViewCommand.mockClear()
    act(() => emitBrowserContentChanged('browser-1'))
    await flush()
    expect(browserViewCommand).toHaveBeenCalledTimes(1)
    expect(browserViewCommand).toHaveBeenCalledWith('browser-1', 41, { op: 'capturePage' })
  })

  it('lets the agent switch the placeholder to a fixed mobile viewport', async () => {
    mount()
    await flush()
    const controller = portalMocks.registerController.mock.calls.at(-1)?.[1]

    act(() => controller.setViewport({ preset: 'mobile', width: 390, height: 844 }))

    expect(placeholder().style.width).toBe('195px')
    expect(placeholder().style.height).toBe('422px')
  })

  it('keeps the tab strip above a blank start page without exposing the sentinel to native content', async () => {
    mount({ tabs: [{ id: 'tab-1', url: 'cate://newtab', title: '' }] })
    await flush()

    const tabStrip = host.querySelector('[data-testid="browser-tab-strip"]') as HTMLElement
    const toolbar = host.querySelector('[data-browser-toolbar]') as HTMLElement
    expect(tabStrip.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('')
    expect(host.textContent).toContain('Start page')
    expect(placeholder().dataset.browserSrc).toBe('about:blank')
  })

  it('routes navigation through the native view facade', async () => {
    mount({ tabs: [{ id: 'tab-1', url: 'cate://newtab', title: '' }] })
    await flush()
    const controller = portalMocks.registerController.mock.calls.at(-1)?.[1]

    act(() => controller.navigate('https://destination.example'))
    await flush()

    expect(browserViewCommand).toHaveBeenCalledWith(
      'browser-1',
      41,
      { op: 'loadURL', url: 'https://destination.example' },
    )
  })

  it('opens password management as an internal browser tab', async () => {
    mount()
    await flush()
    act(() => { (host.querySelector('button[aria-label="Browser menu"]') as HTMLButtonElement).click() })
    act(() => {
      ;([...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Open password manager') as HTMLButtonElement).click()
    })
    expect(host.textContent).toContain('Password manager page')
  })

  it('persists native navigation events and updates navigation controls', async () => {
    mount()
    await flush()
    nativeState = { ...nativeState, title: 'Navigated title', canGoBack: true, canGoForward: false }
    emit('page-title-updated', { title: 'Navigated title' })
    recordVisit.mockClear()
    emit('did-navigate', { url: 'https://navigated.example/page' })
    await flush()

    expect(updateBrowserActiveTabUrl).toHaveBeenCalledWith('ws-1', 'browser-1', 'https://navigated.example/page')
    expect(recordVisit).toHaveBeenCalledWith('https://navigated.example/page', 'Navigated title')
    expect((host.querySelector('button[aria-label="Back"]') as HTMLButtonElement).disabled).toBe(false)
    expect((host.querySelector('button[aria-label="Forward"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('ignores subframe failures and retries a main-frame failure', async () => {
    mount()
    await flush()
    emit('did-fail-load', { errorCode: -105, errorDescription: 'Tracker failed', isMainFrame: false })
    expect(host.textContent).not.toContain('Tracker failed')
    emit('did-fail-load', { errorCode: -105, errorDescription: 'DNS lookup failed', isMainFrame: true })
    expect(host.textContent).toContain('DNS lookup failed')

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Try Again')!
    act(() => retry.click())
    expect(browserViewCommand).toHaveBeenCalledWith('browser-1', 41, { op: 'reload' })
  })

  it('waits for proxy configuration before creating the native view', async () => {
    let releaseProxy!: () => void
    browserSetProxy.mockReturnValueOnce(new Promise<void>((resolve) => { releaseProxy = resolve }))
    useSettingsStore.setState({ browserProxyUrl: ' http://proxy.example:8080 ' })
    mount()

    expect(host.querySelector('[data-browser-native-view]')).toBeNull()
    expect(browserViewCreate).not.toHaveBeenCalled()
    await act(async () => { releaseProxy(); await Promise.resolve() })
    await flush()
    expect(browserViewCreate.mock.calls[0][0].partition).toMatch(/^persist:browser-proxy-/)
  })

  it('unregisters and destroys the native view on unmount', async () => {
    mount()
    await flush()
    expect(portalMocks.register).toHaveBeenCalledWith('browser-1', expect.any(Object))
    act(() => root.unmount())
    expect(portalMocks.unregister).toHaveBeenCalledWith('browser-1')
    expect(portalMocks.unregisterController).toHaveBeenCalledWith('browser-1')
    expect(browserViewDestroy).toHaveBeenCalledWith('browser-1', 41)
    expect(unsubscribeShortcut).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })

  it('keeps inactive tabs live and does not reload them on selection', async () => {
    mount({
      tabs: [
        { id: 'tab-1', url: 'https://one.example', title: 'One' },
        { id: 'tab-2', url: 'https://two.example', title: 'Two' },
      ],
      activeTabId: 'tab-1',
    })
    await flush()
    expect(browserViewCreate).toHaveBeenCalledTimes(2)
    expect(browserControl).toHaveBeenCalledWith({
      op: 'registerAgentBrowser', webContentsId: 41, panelId: 'browser-1', tabId: 'tab-1',
    })
    await vi.waitFor(() => {
      expect(browserViewCommand).toHaveBeenCalledWith(
        'browser-1', 41, { op: 'loadURL', url: 'https://one.example' },
      )
      expect(browserViewCommand).toHaveBeenCalledWith(
        'browser-1', 42, { op: 'loadURL', url: 'https://two.example' },
      )
    })
    browserViewCommand.mockClear()

    const controller = portalMocks.registerController.mock.calls[0][1]
    act(() => { expect(controller.selectTab('tab-2')).toBe(true) })
    await flush()
    expect(browserViewCreate).toHaveBeenCalledTimes(2)
    expect(browserViewDestroy).not.toHaveBeenCalled()
    expect(browserViewCommand).not.toHaveBeenCalledWith(
      'browser-1',
      42,
      expect.objectContaining({ op: 'loadURL' }),
    )
    expect(browserControl).toHaveBeenCalledWith({
      op: 'registerAgentBrowser', webContentsId: 42, panelId: 'browser-1', tabId: 'tab-2',
    })
  })

  it('forwards password-focus metadata through the native view bridge', async () => {
    mount()
    await flush()
    emit('password-focus', {
      payload: {
        targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        rect: { left: 20, bottom: 80, width: 200, height: 30 },
      },
    })
    await flush()

    expect(browserCredentialSuggestions).toHaveBeenCalledWith(41)
    expect(host.textContent).toContain('person@example.com')
    const choice = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('person@example.com'))!
    act(() => choice.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    await flush()
    expect(browserCredentialFill).toHaveBeenCalledWith({
      webContentsId: 41,
      credentialId: 'credential-1',
      targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
  })
})
