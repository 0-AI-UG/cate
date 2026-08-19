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
  BrowserMenu: ({ onZoomOut, onZoomReset, zoomPercent }: {
    onZoomOut: () => void
    onZoomReset: () => void
    zoomPercent: number
  }) => (
    <>
      <button onClick={onZoomOut}>Zoom out</button>
      <button onClick={onZoomReset}>Reset zoom ({zoomPercent}%)</button>
    </>
  ),
}))
vi.mock('./BrowserPasswordManagerPage', () => ({ BrowserPasswordManagerPage: () => null }))
vi.mock('./BrowserTabStrip', () => ({ BrowserTabStrip: () => <div data-testid="browser-tab-strip" /> }))
vi.mock('./BrowserBookmarksSidebar', () => ({ BrowserBookmarksSidebar: () => null }))

import BrowserPanel, { browserViewportScale } from './BrowserPanel'
import { useAppStore } from '../stores/appStore'
import { useBrowserStore } from '../stores/browserStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { BrowserTab } from '../../shared/types'

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

let host: HTMLDivElement
let root: Root

function mount(options?: {
  proxyUrl?: string
  tabs?: BrowserTab[]
  activeTabId?: string
}): void {
  const tabs = options?.tabs ?? [{ id: 'tab-1', url: 'https://initial.example', title: 'Initial' }]
  act(() => {
    root.render(
      <BrowserPanel
        panelId="browser-1"
        workspaceId="ws-1"
        nodeId="node-1"
        proxyUrl={options?.proxyUrl}
        tabs={tabs}
        activeTabId={options?.activeTabId ?? tabs[0].id}
      />,
    )
  })
}

function guestEvent(type: string, fields: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type), fields)
}

function installWebviewMethods(webview: HTMLElement, webContentsId = 42) {
  const methods = {
    loadURL: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    getURL: vi.fn(() => 'https://navigated.example/page'),
    getTitle: vi.fn(() => 'Navigated title'),
    getWebContentsId: vi.fn(() => webContentsId),
    getZoomFactor: vi.fn(() => 1),
    insertCSS: vi.fn(async () => 'css-key'),
    setZoomFactor: vi.fn(),
    executeJavaScript: vi.fn(async () => undefined),
  }
  Object.assign(webview, methods)
  return methods
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
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
  useAppStore.setState(initialAppState, true)
  useBrowserStore.setState(initialBrowserState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('BrowserPanel DOM webview', () => {
  it('uses one CSS transform for the guest viewport and overlay coordinate space', () => {
    mount()

    const webview = host.querySelector('webview') as HTMLElement
    expect(webview.style.transform).toBe('scale(0.75)')
    expect(webview.style.transformOrigin).toBe('top left')
    expect(webview.style.width).toBe(`${100 / 0.75}%`)
    expect(browserViewportScale(
      { preset: 'desktop', width: 1280, height: 800 },
      { width: 800, height: 500 },
    )).toBe(0.625)
  })

  it('switches to a fixed viewport without a main-process bounds relay', () => {
    mount()
    const controller = portalMocks.registerController.mock.calls.at(-1)?.[1]

    act(() => controller.setViewport({ preset: 'mobile', width: 390, height: 844 }))

    const webview = host.querySelector('webview') as HTMLElement
    expect(webview.style.width).toBe('390px')
    expect(webview.style.height).toBe('844px')
    expect(webview.style.transform).toBe('scale(0.5)')
  })

  it('keeps a hidden about:blank guest live on the start page for automation', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    mount({ tabs: [{ id: 'tab-1', url: 'cate://newtab', title: '' }] })

    const webview = host.querySelector('webview') as HTMLElement
    expect(host.textContent).toContain('Start page')
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('')
    expect(webview.getAttribute('src')).toBe('about:blank')
    expect(webview.classList.contains('invisible')).toBe(true)
    expect(webview.getAttribute('webpreferences')).toBe('backgroundThrottling=no')
    expect(focus).not.toHaveBeenCalled()
    focus.mockRestore()
  })

  it('registers the live guest, initializes zoom, and injects guest CSS', async () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    const methods = installWebviewMethods(webview, 41)

    act(() => webview.dispatchEvent(guestEvent('dom-ready')))
    await flush()

    expect(portalMocks.register).toHaveBeenCalledWith('browser-1', webview)
    expect(methods.setZoomFactor).toHaveBeenCalledWith(1)
    expect(methods.insertCSS).toHaveBeenCalledWith(expect.stringContaining('height:8px'))
    expect(browserControl).toHaveBeenCalledWith({
      op: 'registerAgentBrowser', webContentsId: 41, panelId: 'browser-1', tabId: 'tab-1',
    })
  })

  it('persists guest navigation and updates navigation controls', () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    installWebviewMethods(webview)

    act(() => webview.dispatchEvent(guestEvent('did-navigate', {
      url: 'https://navigated.example/page',
    })))

    expect(updateBrowserActiveTabUrl).toHaveBeenCalledWith(
      'ws-1', 'browser-1', 'https://navigated.example/page',
    )
    expect(recordVisit).toHaveBeenCalledWith('https://navigated.example/page', 'Navigated title')
    expect((host.querySelector('button[aria-label="Back"]') as HTMLButtonElement).disabled).toBe(false)
    expect((host.querySelector('button[aria-label="Forward"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses the persisted panel proxy before the global setting', async () => {
    let releaseProxy!: () => void
    browserSetProxy.mockReturnValueOnce(new Promise<void>((resolve) => { releaseProxy = resolve }))
    useSettingsStore.setState({ browserProxyUrl: 'http://global.example:8080' })

    mount({ proxyUrl: ' http://panel.example:9090 ' })
    expect(host.querySelector('webview')).toBeNull()
    expect(browserSetProxy).toHaveBeenCalledWith(
      expect.stringMatching(/^persist:browser-proxy-/), 'http://panel.example:9090',
    )

    await act(async () => { releaseProxy(); await Promise.resolve() })
    expect(host.querySelector('webview')).toBeTruthy()
  })

  it('keeps every visible tab guest live to preserve in-page state', () => {
    mount({
      tabs: [
        { id: 'tab-1', url: 'https://one.example', title: 'One' },
        { id: 'tab-2', url: 'https://two.example', title: 'Two' },
      ],
      activeTabId: 'tab-1',
    })

    expect(host.querySelectorAll('webview')).toHaveLength(2)
    expect(host.querySelectorAll('[data-browser-webview-slot].absolute')).toHaveLength(1)
  })

  it('receives password-focus metadata through sendToHost IPC', async () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    installWebviewMethods(webview)

    act(() => webview.dispatchEvent(guestEvent('ipc-message', {
      channel: 'cate-browser-password-focus',
      args: [{
        targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        rect: { left: 20, bottom: 80, width: 200, height: 30 },
      }],
    })))
    await flush()

    expect(browserCredentialSuggestions).toHaveBeenCalledWith(42)
    const choice = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('person@example.com'))!
    act(() => choice.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    await flush()
    expect(browserCredentialFill).toHaveBeenCalledWith({
      webContentsId: 42,
      credentialId: 'credential-1',
      targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
  })

  it('generation-scopes registry cleanup when the panel host changes', () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    installWebviewMethods(webview)
    act(() => webview.dispatchEvent(guestEvent('dom-ready')))
    const controller = portalMocks.registerController.mock.calls[0][1]

    act(() => root.unmount())

    expect(portalMocks.unregister).toHaveBeenCalledWith('browser-1', webview)
    expect(portalMocks.unregisterController).toHaveBeenCalledWith('browser-1', controller)
    expect(unsubscribeShortcut).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })
})
