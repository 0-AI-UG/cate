import React from 'react'
import { act } from 'react'
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
  BrowserMenu: ({
    onOpenPasswordManager,
    onZoomOut,
    onZoomIn,
    onZoomReset,
    zoomPercent,
  }: {
    onOpenPasswordManager: () => void
    onZoomOut: () => void
    onZoomIn: () => void
    onZoomReset: () => void
    zoomPercent: number
  }) => (
    <>
      <button onClick={onOpenPasswordManager}>Open password manager</button>
      <button onClick={onZoomOut}>Zoom out</button>
      <button onClick={onZoomIn}>Zoom in</button>
      <button onClick={onZoomReset}>Reset zoom ({zoomPercent}%)</button>
    </>
  ),
}))
vi.mock('./BrowserPasswordManagerPage', () => ({
  BrowserPasswordManagerPage: () => <div>Password manager page</div>,
}))
vi.mock('./BrowserTabStrip', () => ({
  BrowserTabStrip: () => <div data-testid="browser-tab-strip" />,
}))
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

function mount(options?: { proxyUrl?: string; tabs?: BrowserTab[]; activeTabId?: string }): void {
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

function event(type: string, fields: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type), fields)
}

function installWebviewMethods(webview: HTMLElement) {
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
    getWebContentsId: vi.fn(() => 42),
    getZoomFactor: vi.fn(() => 1),
    insertCSS: vi.fn(async () => 'css-key'),
    setZoomFactor: vi.fn(),
    executeJavaScript: vi.fn(async () => undefined),
  }
  Object.assign(webview, methods)
  return methods
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useAppStore.setState({
    updatePanelTitle,
    updateBrowserActiveTabUrl,
    updatePanelTabs,
  })
  useBrowserStore.setState({
    bookmarks: [],
    recordVisit,
    toggleBookmark: vi.fn(),
    querySuggestions: vi.fn(() => []),
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
      directImportSupported: false,
      secureStorageAvailable: true,
      profiles: [],
      importedCount: 0,
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

describe('BrowserPanel component', () => {
  it('renders a larger logical viewport at 75% scale by default', () => {
    mount()

    const webview = host.querySelector('webview') as HTMLElement
    expect(webview.style.transform).toBe('scale(0.75)')
    expect(webview.style.width).toBe(`${100 / 0.75}%`)
    expect(browserViewportScale(
      { preset: 'desktop', width: 1280, height: 800 },
      { width: 800, height: 500 },
    )).toBe(0.625)
  })

  it('lets the agent switch the live panel to a fixed mobile viewport', () => {
    mount()
    const controller = portalMocks.registerController.mock.calls.at(-1)?.[1]

    act(() => {
      controller.setViewport({ preset: 'mobile', width: 390, height: 844 })
    })

    const webview = host.querySelector('webview') as HTMLElement
    expect(webview.style.width).toBe('390px')
    expect(webview.style.height).toBe('844px')
    expect(webview.style.transform).toBe('scale(0.5)')
  })

  it('keeps the tab strip above a blank new-tab address bar', () => {
    mount({
      tabs: [{ id: 'tab-1', url: 'cate://newtab', title: '' }],
    })

    const tabStrip = host.querySelector('[data-testid="browser-tab-strip"]') as HTMLElement
    const toolbar = host.querySelector('[data-browser-toolbar]') as HTMLElement
    const input = host.querySelector('input') as HTMLInputElement

    expect(tabStrip.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Enter a URL')
    expect(host.textContent).toContain('Start page')
    expect(host.querySelector('button[aria-label="Open address"]')).toBeTruthy()
    const webview = host.querySelector('webview')
    expect(webview).toBeTruthy()
    expect(webview?.getAttribute('src')).toBe('about:blank')
    expect(webview?.classList.contains('invisible')).toBe(true)
  })

  it('never sends the start-page sentinel to the guest while navigating', async () => {
    mount({
      tabs: [{ id: 'tab-1', url: 'cate://newtab', title: '' }],
    })
    const webview = host.querySelector('webview') as HTMLElement
    const methods = installWebviewMethods(webview)
    const controller = portalMocks.registerController.mock.calls.at(-1)?.[1]

    act(() => {
      controller.navigate('https://destination.example')
    })
    await flush()

    expect(methods.loadURL).toHaveBeenCalledWith('https://destination.example')
    expect(webview.getAttribute('src')).toBe('about:blank')
  })

  it('opens password management as an internal browser tab', () => {
    mount()

    act(() => {
      ;(host.querySelector('button[aria-label="Browser menu"]') as HTMLButtonElement).click()
    })
    act(() => {
      ;([...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Open password manager') as HTMLButtonElement).click()
    })

    expect(host.textContent).toContain('Password manager page')
    expect(updatePanelTabs).toHaveBeenLastCalledWith(
      'ws-1',
      'browser-1',
      expect.arrayContaining([
        expect.objectContaining({
          url: 'chrome://password-manager/passwords',
          title: 'Password manager',
        }),
      ]),
      expect.any(String),
    )
  })

  it('persists a completed navigation, records history, and updates navigation controls', () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    const methods = installWebviewMethods(webview)

    act(() => {
      webview.dispatchEvent(event('did-navigate', { url: 'https://navigated.example/page' }))
    })

    expect(updateBrowserActiveTabUrl).toHaveBeenCalledWith(
      'ws-1',
      'browser-1',
      'https://navigated.example/page',
    )
    expect(recordVisit).toHaveBeenCalledWith('https://navigated.example/page', 'Navigated title')
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('https://navigated.example/page')
    expect((host.querySelector('button[aria-label="Back"]') as HTMLButtonElement).disabled).toBe(false)
    expect((host.querySelector('button[aria-label="Forward"]') as HTMLButtonElement).disabled).toBe(true)
    expect(updatePanelTabs).toHaveBeenLastCalledWith(
      'ws-1',
      'browser-1',
      [{ id: 'tab-1', url: 'https://navigated.example/page', title: 'Navigated title' }],
      'tab-1',
    )
    expect(methods.canGoBack).toHaveBeenCalled()
  })

  it('ignores subframe failures but surfaces a main-frame failure with a working retry', () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    const methods = installWebviewMethods(webview)

    act(() => {
      webview.dispatchEvent(event('did-fail-load', {
        errorCode: -105,
        errorDescription: 'Tracker failed',
        isMainFrame: false,
      }))
    })
    expect(host.textContent).not.toContain('Tracker failed')

    act(() => {
      webview.dispatchEvent(event('did-fail-load', {
        errorCode: -105,
        errorDescription: 'DNS lookup failed',
        isMainFrame: true,
      }))
    })
    expect(host.textContent).toContain('DNS lookup failed')

    const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Try Again')
    expect(retry).toBeTruthy()
    act(() => retry!.click())
    expect(methods.reload).toHaveBeenCalledTimes(1)
  })

  it('waits for proxy configuration before attaching the webview', async () => {
    let releaseProxy!: () => void
    browserSetProxy.mockReturnValueOnce(new Promise<void>((resolve) => { releaseProxy = resolve }))
    useSettingsStore.setState({ browserProxyUrl: ' http://proxy.example:8080 ' })

    mount()

    expect(host.querySelector('webview')).toBeNull()
    expect(browserSetProxy).toHaveBeenCalledTimes(1)
    expect(browserSetProxy.mock.calls[0][0]).toMatch(/^persist:browser-proxy-/)
    expect(browserSetProxy.mock.calls[0][1]).toBe('http://proxy.example:8080')

    await act(async () => {
      releaseProxy()
      await Promise.resolve()
    })
    const webview = host.querySelector('webview')
    expect(webview).toBeTruthy()
    expect(webview?.getAttribute('partition')).toMatch(/^persist:browser-proxy-/)
  })

  it('unregisters the guest and subscriptions, and removes webview listeners on unmount', async () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    installWebviewMethods(webview)
    act(() => webview.dispatchEvent(event('dom-ready')))
    expect(portalMocks.register).toHaveBeenCalledWith('browser-1', webview)
    // The navigator registers at mount (not dom-ready): it is how the reverse
    // API reaches a panel sitting on its start page, which has no webview.
    expect(portalMocks.registerController).toHaveBeenCalledWith('browser-1', expect.any(Object))

    act(() => root.unmount())
    expect(portalMocks.unregister).toHaveBeenCalledWith('browser-1')
    expect(portalMocks.unregisterController).toHaveBeenCalledWith('browser-1')
    expect(unsubscribeShortcut).toHaveBeenCalledTimes(1)

    const persistedCalls = updateBrowserActiveTabUrl.mock.calls.length
    act(() => webview.dispatchEvent(event('did-navigate', { url: 'https://late.example' })))
    expect(updateBrowserActiveTabUrl).toHaveBeenCalledTimes(persistedCalls)

    root = createRoot(host)
    await flush()
  })

  it('shows horizontal guest scrollbars and scales browser content from the menu', async () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    const methods = installWebviewMethods(webview)

    act(() => webview.dispatchEvent(event('dom-ready')))
    await flush()

    expect(methods.insertCSS).toHaveBeenCalledWith(expect.stringContaining('height:8px'))
    expect(methods.setZoomFactor).toHaveBeenLastCalledWith(1)
    methods.setZoomFactor.mockClear()
    act(() => webview.dispatchEvent(event('dom-ready')))
    await flush()
    expect(methods.insertCSS).toHaveBeenCalledTimes(2)
    expect(methods.setZoomFactor).not.toHaveBeenCalled()

    act(() => {
      ;(host.querySelector('button[aria-label="Browser menu"]') as HTMLButtonElement).click()
    })
    const zoomOut = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Zoom out') as HTMLButtonElement
    act(() => zoomOut.click())

    expect(methods.setZoomFactor).toHaveBeenLastCalledWith(0.9)
    expect(host.textContent).toContain('Reset zoom (90%)')

    const reset = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Reset zoom')) as HTMLButtonElement
    act(() => reset.click())
    expect(methods.setZoomFactor).toHaveBeenLastCalledWith(1)
  })

  it('keeps only the active tab live and registers it with agent-browser', async () => {
    mount({
      tabs: [
        { id: 'tab-1', url: 'https://one.example', title: 'One' },
        { id: 'tab-2', url: 'https://two.example', title: 'Two' },
      ],
      activeTabId: 'tab-1',
    })
    const webviews = Array.from(host.querySelectorAll('webview')) as HTMLElement[]
    expect(webviews).toHaveLength(1)
    const first = installWebviewMethods(webviews[0])
    first.getWebContentsId.mockReturnValue(41)

    act(() => webviews[0].dispatchEvent(event('dom-ready')))
    await flush()
    expect(browserControl).toHaveBeenCalledWith({
      op: 'registerAgentBrowser',
      webContentsId: 41,
      panelId: 'browser-1',
      tabId: 'tab-1',
    })

    const controller = portalMocks.registerController.mock.calls[0][1] as {
      selectTab(id: string): boolean
    }
    act(() => { expect(controller.selectTab('tab-2')).toBe(true) })
    await flush()

    expect(host.contains(webviews[0])).toBe(false)
    const secondWebview = host.querySelector('webview') as HTMLElement
    expect(secondWebview).not.toBe(webviews[0])
    const second = installWebviewMethods(secondWebview)
    second.getWebContentsId.mockReturnValue(42)
    act(() => secondWebview.dispatchEvent(event('dom-ready')))
    await flush()
    expect(first.loadURL).not.toHaveBeenCalled()
    expect(second.loadURL).not.toHaveBeenCalled()
    expect(browserControl).toHaveBeenCalledWith({
      op: 'registerAgentBrowser',
      webContentsId: 42,
      panelId: 'browser-1',
      tabId: 'tab-2',
    })
  })

  it('shows only username metadata and delegates password filling to main', async () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    installWebviewMethods(webview)

    act(() => {
      webview.dispatchEvent(event('ipc-message', {
        channel: 'cate-browser-password-focus',
        args: [{
          targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          rect: { left: 20, bottom: 80, width: 200, height: 30 },
        }],
      }))
    })
    await flush()

    expect(browserCredentialSuggestions).toHaveBeenCalledWith(42)
    expect(host.textContent).toContain('person@example.com')
    expect(host.textContent).not.toContain('password-value')

    const choice = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('person@example.com'))
    expect(choice).toBeTruthy()
    act(() => choice!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    await flush()
    expect(browserCredentialFill).toHaveBeenCalledWith({
      webContentsId: 42,
      credentialId: 'credential-1',
      targetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
  })
})
