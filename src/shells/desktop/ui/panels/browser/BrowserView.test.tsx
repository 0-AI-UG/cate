import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { installMockClientUi } from '../../../../../test/clientUi'
import { createClientIdentity, installClientIdentity, type SessionHandle } from '@client/connections'
import type { PanelRecord } from '@workspace/document/contract'
import { installBrowserPageBridge, installBrowserPartitions, openEngineSurface } from '@services/browser/desktop/renderer'
import type { BrowserOp, BrowserSnapshot, BrowserTab } from '@panels/browser/contract'
import BrowserView from './BrowserView'

// No open workspace in these tests: which tab a client shows lives in React state.
vi.mock('../../client/document', async (importOriginal) => {
  const { useState } = await import('react')
  return {
    ...(await importOriginal<typeof import('../../client/document')>()),
    usePanelView: (_ws: string, _panel: string, _key: string, fallback: unknown) => useState(fallback),
  }
})
import { runSurfaceRequest } from '@client/host'

vi.mock('@services/browser/desktop/renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@services/browser/desktop/renderer')>()),
  openEngineSurface: vi.fn(),
}))
vi.mock('../../client/host/surfaceRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../client/host/surfaceRegistry')>()),
  surfaceDisplayScale: () => 1,
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tab = (patch: Partial<BrowserTab> = {}): BrowserTab => ({ id: 't1', url: 'cate://newtab', title: '', favicon: null, pinned: false, nav: 0, navSource: null, openedBy: null, ...patch })
const snapshotOf = (tabs: BrowserTab[], patch: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({
  tabs, activeTabId: tabs[0].id, activeSource: null, viewport: { preset: 'compact' },
  canGoBack: false, canGoForward: false, isLoading: false, loadError: null, crashed: false, downloads: [], agentCursor: null,
  ...patch,
})

let host: HTMLDivElement
let root: Root
let restoreRuntime: () => void
const send = vi.fn(async (_op: BrowserOp) => undefined)
const record: PanelRecord = { id: 'p1', type: 'browser', title: 'Browser', fields: {} }
const session = {} as SessionHandle<BrowserSnapshot>
/** Workspaces whose partition the shell is still preparing. */
let preparing = new Set<string>()
const partitionListeners = new Set<() => void>()

function render(snapshot: BrowserSnapshot | null, props: { focused?: boolean; strict?: boolean } = {}) {
  const view = (
    <BrowserView workspaceId="ws" panelId="p1" record={record} session={session} send={send}
      snapshot={snapshot} visible focused={props.focused ?? false} />
  )
  act(() => root.render(props.strict ? <StrictMode>{view}</StrictMode> : view))
}

beforeEach(() => {
  send.mockClear()
  vi.mocked(openEngineSurface).mockImplementation(async (canvas, _input, _secure, options) => ({
    surface: Object.assign(canvas, {
      getWebContentsId: () => 1, getURL: () => options.url, getTitle: () => '',
      loadURL: vi.fn(async () => {}), canGoBack: () => false, canGoForward: () => false,
      isLoading: () => false, goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(),
      reloadIgnoringCache: vi.fn(), getZoomFactor: () => 1, setZoomFactor: vi.fn(),
      insertCSS: async () => '', setVisible: vi.fn(),
    }),
    dispose: vi.fn(),
  }))
  installMockClientUi()
  installClientIdentity(createClientIdentity({ device: { name: 'test', publicKey: 'f' }, features: ['webview', 'pageDriver'] }))
  preparing = new Set()
  partitionListeners.clear()
  installBrowserPartitions({
    partition: (workspaceId) => (preparing.has(workspaceId) ? null : `persist:ws-${workspaceId}-runtime`),
    subscribe(listener) {
      partitionListeners.add(listener)
      return () => { partitionListeners.delete(listener) }
    },
  })
  installBrowserPageBridge({
    protectPage: vi.fn(async () => {}),
    attach: vi.fn(async () => {}), restartIfHung: vi.fn(async () => false), onDialog: () => () => {}, onPassword: () => () => {},
    onOpenTab: () => () => {},
    onShortcut: () => () => {},
    onDownloads: () => () => {},
    chromeProfiles: async () => ({ directImportSupported: false, profiles: [] }),
  } as never)
  const runtime = {
    browserData: {
      history: vi.fn(async () => [{ url: 'https://docs.test/', title: 'Docs', lastVisited: 1, visitCount: 1 }]),
      bookmarks: vi.fn(async () => []),
      changes: () => ({ onEvent: () => () => {}, cancel: () => {} }),
      passwords: vi.fn(async () => []),
    },
  } as unknown as RuntimeProxy
  restoreRuntime = setRuntimeResolver((id) => (id === 'ws' ? runtime : null))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  restoreRuntime()
  installBrowserPageBridge(null)
  installBrowserPartitions(null)
  installClientIdentity(null)
})

describe('BrowserView', () => {
  it('shows a placeholder until the first snapshot', () => {
    render(null)
    expect(host.textContent).toContain('Loading')
  })

  it('waits for the workspace partition, then renders once it is prepared', () => {
    preparing.add('ws')
    render(snapshotOf([tab({ url: 'https://a.test/' })]))
    expect(host.textContent).toContain('Loading')
    expect(host.querySelector('[data-browser-page-slot]')).toBeNull()

    preparing.delete('ws')
    act(() => { for (const listener of [...partitionListeners]) listener() })
    expect(host.querySelector('[data-browser-page-slot]')?.getAttribute('data-browser-partition')).toBe('persist:ws-ws-runtime')
  })

  it('defers the start guest until navigation, then retains it on return', async () => {
    render(snapshotOf([tab()]))
    expect(host.textContent).toContain('Enter a URL to open a page')
    expect(host.querySelector('canvas')).toBeNull()
    render(snapshotOf([tab({ url: 'https://a.test/', nav: 1 })]))
    await act(async () => {})
    const guest = host.querySelector('canvas')
    expect(guest).not.toBeNull()
    expect(host.querySelector('[data-browser-page-slot]')?.getAttribute('data-browser-partition')).toBe('persist:ws-ws-runtime')
    render(snapshotOf([tab({ nav: 2 })]))
    expect(host.querySelector('canvas')).toBe(guest)
  })

  it('sends address bar input as a navigate op', () => {
    render(snapshotOf([tab()]))
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Enter a URL"]')!
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setValue.call(input, 'example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(send).toHaveBeenCalledWith({ kind: 'navigate', input: 'example.com', tabId: 't1' })
  })

  it('sends tab ops from the tab strip', () => {
    render(snapshotOf([tab(), tab({ id: 't2', url: 'https://b.test/', title: 'B' })]))
    const second = host.querySelector<HTMLElement>('[title^="B ·"]')
    act(() => second?.click())
    expect(send).toHaveBeenCalledWith({ kind: 'selectTab', tabId: 't2' })
  })

  it('shows its own tab: another client\'s selection does not move it, a caller\'s does', () => {
    const tabs = [tab({ url: 'https://a.test/' }), tab({ id: 't2', url: 'https://b.test/', title: 'B' }), tab({ id: 't3', url: 'https://c.test/' })]
    const shown = () => host.querySelector('[data-browser-page-slot]:not(.invisible)')?.getAttribute('data-browser-src')
    render(snapshotOf(tabs))
    expect(shown()).toBe('https://a.test/')
    render(snapshotOf(tabs, { activeTabId: 't2', activeSource: 'someone-else' }))
    expect(shown()).toBe('https://a.test/')
    render(snapshotOf(tabs, { activeTabId: 't3', activeSource: null }))
    expect(shown()).toBe('https://c.test/')
    act(() => host.querySelector<HTMLElement>('[title^="B ·"]')?.click())
    expect(shown()).toBe('https://b.test/')
    expect(send).toHaveBeenCalledWith({ kind: 'selectTab', tabId: 't2' })
  })

  it('mounts a tab\'s page only once this client shows it, then keeps it', () => {
    const slots = () => [...host.querySelectorAll('[data-browser-page-slot]')].map((slot) => slot.getAttribute('data-browser-src'))
    const tabs = [tab({ url: 'https://a.test/' }), tab({ id: 't2', url: 'https://b.test/', title: 'B' })]
    render(snapshotOf(tabs))
    render(snapshotOf(tabs, { activeTabId: 't2', activeSource: 'someone-else' }))
    expect(slots()).toEqual(['https://a.test/'])
    const firstSurface = host.querySelector('canvas')
    expect(firstSurface).not.toBeNull()
    act(() => host.querySelector<HTMLElement>('[title^="B ·"]')?.click())
    expect(slots()).toEqual(['https://a.test/', 'https://b.test/'])
    expect(host.querySelector('canvas')).toBe(firstSurface)
  })

  it('renders internal pages without an engine surface', async () => {
    render(snapshotOf([tab({ url: 'chrome://history/' })]))
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[data-browser-history]')).not.toBeNull()
    expect(host.querySelector('[data-browser-page-slot]')).toBeNull()
  })

  it('registers its pages for page operations when this client drives pages', async () => {
    vi.useFakeTimers()
    render(snapshotOf([tab()]))
    const request = { requestId: 1, panelId: 'p1', op: 'page.nope' }
    await expect(runSurfaceRequest('ws', request)).rejects.toMatchObject({ code: 'unsupported' })
    act(() => root.unmount())
    const gone = expect(runSurfaceRequest('ws', request)).rejects.toMatchObject({ code: 'no-renderer' })
    await vi.advanceTimersByTimeAsync(5_000)
    await gone
    vi.useRealTimers()
    root = createRoot(host)
  })

  it('hands the page back from the agent on user input', () => {
    const agentCursor = { event: { kind: 'click' as const, label: 'click', x: 1, y: 2, toX: null, toY: null }, serial: 1 }
    render(snapshotOf([tab()], { agentCursor }))
    act(() => { host.querySelector('[data-browser-toolbar]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(send).toHaveBeenCalledWith({ kind: 'releaseAgentCursor' })
  })

  it('loads a navigation under StrictMode, whose first mount is disposed', async () => {
    render(snapshotOf([tab({ url: 'about:blank' })]), { strict: true })
    await act(async () => {})
    const loadURL = vi.fn()
    const webview = Object.assign(host.querySelector('canvas')!, {
      loadURL, getWebContentsId: () => 1, getURL: () => 'about:blank',
      setZoomFactor: () => {}, insertCSS: async () => {},
    })
    act(() => { webview.dispatchEvent(new Event('dom-ready')) })
    render(snapshotOf([tab({ url: 'https://a.test/', nav: 1 })]), { strict: true })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(loadURL).toHaveBeenCalledWith('https://a.test/')
  })
})
