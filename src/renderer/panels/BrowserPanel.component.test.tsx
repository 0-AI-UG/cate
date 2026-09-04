// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const portalMocks = vi.hoisted(() => ({
  register: vi.fn(), unregister: vi.fn(), registerController: vi.fn(), unregisterController: vi.fn(),
}))

vi.mock('../lib/portalRegistry', () => ({ portalRegistry: portalMocks }))
vi.mock('../ui/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./UrlSuggestions', () => ({ UrlSuggestions: () => null }))
vi.mock('./StartPage', () => ({ StartPage: () => <div>Start page</div> }))
vi.mock('./BrowserMenu', () => ({ BrowserMenu: () => null }))
vi.mock('./BrowserHistoryPage', () => ({ BrowserHistoryPage: () => <div data-testid="browser-history" /> }))
vi.mock('./BrowserPasswordManagerPage', () => ({ BrowserPasswordManagerPage: () => null }))
vi.mock('./BrowserTabStrip', () => ({ BrowserTabStrip: () => <div data-testid="browser-tabs" /> }))
vi.mock('./BrowserBookmarksSidebar', () => ({ BrowserBookmarksSidebar: () => null }))

import BrowserPanel from './BrowserPanel'
import { useAppStore } from '../stores/appStore'
import { useBrowserStore } from '../stores/browserStore'
import { useSettingsStore } from '../stores/settingsStore'

const browserControl = vi.fn(async () => ({ ok: true }))
let downloadsChanged: ((payload: {
  webContentsId: number
  downloads: import('../../shared/types').BrowserDownloadEntry[]
}) => void) | null = null
let host: HTMLDivElement
let root: Root

function installWebviewMethods(webview: HTMLElement, webContentsId = 42) {
  const methods = {
    loadURL: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), reloadIgnoringCache: vi.fn(),
    canGoBack: vi.fn(() => false), canGoForward: vi.fn(() => false), isLoading: vi.fn(() => false),
    getURL: vi.fn(() => 'https://example.test/'), getTitle: vi.fn(() => 'Example'),
    getWebContentsId: vi.fn(() => webContentsId), getZoomFactor: vi.fn(() => 1),
    insertCSS: vi.fn(async () => 'css-key'), setZoomFactor: vi.fn(), executeJavaScript: vi.fn(async () => undefined),
  }
  Object.assign(webview, methods)
  return methods
}

beforeEach(() => {
  vi.clearAllMocks()
  downloadsChanged = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useAppStore.setState({
    updatePanelTitle: vi.fn(), updateBrowserActiveTabUrl: vi.fn(), updatePanelTabs: vi.fn(),
  })
  useBrowserStore.setState({ bookmarks: [], recordVisit: vi.fn(), toggleBookmark: vi.fn(), querySuggestions: vi.fn(() => []) })
  useSettingsStore.setState({
    browserHomepage: '', browserSearchEngine: 'google', browserProxyUrl: '',
    browserNewTabBehavior: 'startPage', browserShowTabSidebar: false, setSetting: vi.fn(),
  })
  Object.assign(window, { electronAPI: {
    browserControl, browserSetProxy: vi.fn(async () => undefined), onBrowserShortcut: vi.fn(() => () => undefined),
    onBrowserOpenTabRequest: vi.fn(() => () => undefined),
    onBrowserDownloadsChanged: vi.fn((callback) => { downloadsChanged = callback; return () => undefined }),
    browserHistoryRecord: vi.fn(async () => undefined), browserCredentialSuggestions: vi.fn(async () => ({ suggestions: [] })),
    browserCredentialFill: vi.fn(async () => ({ ok: true })), webviewScreenshot: vi.fn(async () => null),
    browserClearData: vi.fn(async () => undefined), showContextMenu: vi.fn(async () => null),
  } })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function mount(tabs = [{ id: 'tab-1', url: 'https://example.test/', title: 'Example' }], activeTabId = 'tab-1'): void {
  act(() => root.render(
    <BrowserPanel panelId="browser-1" workspaceId="workspace-1" tabs={tabs} activeTabId={activeTabId} />,
  ))
}

describe('BrowserPanel live webview', () => {
  it('renders browsing history as an internal full page', () => {
    mount([{ id: 'tab-1', url: 'chrome://history/', title: 'History' }])
    expect(host.querySelector('[data-testid="browser-history"]')).not.toBeNull()
    expect(host.querySelector('webview')).toBeNull()
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('chrome://history/')
  })

  it('renders the real guest rather than a captured preview', () => {
    mount()
    expect(host.querySelector('webview')).not.toBeNull()
    expect(host.querySelector('img[alt^="Preview of"]')).toBeNull()
    expect(host.textContent).not.toContain('Open live')
  })

  it('keeps every tab guest mounted so page state survives tab switches', () => {
    mount([
      { id: 'tab-1', url: 'https://one.test/', title: 'One' },
      { id: 'tab-2', url: 'https://two.test/', title: 'Two' },
    ])
    expect(host.querySelectorAll('webview')).toHaveLength(2)
    expect(host.querySelectorAll('[data-browser-webview-slot].absolute')).toHaveLength(1)
  })

  it('attaches the exact guest identity when Chromium reports dom-ready', async () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    installWebviewMethods(webview, 41)
    act(() => webview.dispatchEvent(new Event('dom-ready')))
    await act(async () => { await Promise.resolve() })
    expect(portalMocks.register).toHaveBeenCalledWith('browser-1', webview)
    expect(browserControl).toHaveBeenCalledWith({
      op: 'attach', webContentsId: 41, workspaceId: 'workspace-1', panelId: 'browser-1', tabId: 'tab-1',
    })
  })

  it('does not focus the guest merely because it mounted', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    mount()
    expect(focus).not.toHaveBeenCalled()
    focus.mockRestore()
  })

  it('shows download progress in a toolbar popover for its guest', () => {
    mount()
    const webview = host.querySelector('webview') as HTMLElement
    installWebviewMethods(webview, 42)

    act(() => downloadsChanged?.({
      webContentsId: 99,
      downloads: [{
        id: 'foreign-download',
        url: 'https://other.test/foreign.zip',
        filename: 'foreign.zip',
        filePath: '/tmp/foreign.zip',
        state: 'progressing',
        receivedBytes: 1,
        totalBytes: 2,
        at: 1,
      }],
    }))
    expect(host.querySelector('button[aria-label="Downloads"]')).toBeNull()

    act(() => downloadsChanged?.({
      webContentsId: 42,
      downloads: [{
        id: 'download-1',
        url: 'https://example.test/archive.zip',
        filename: 'archive.zip',
        filePath: '/tmp/archive.zip',
        state: 'progressing',
        receivedBytes: 50,
        totalBytes: 100,
        at: 1,
      }],
    }))

    expect(host.querySelector('button[aria-label="Downloads"]')).not.toBeNull()
    expect(host.querySelector('[data-browser-downloads-popover]')?.textContent).toContain('archive.zip')
  })
})
