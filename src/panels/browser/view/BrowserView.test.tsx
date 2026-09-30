import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { installMockClientUi } from '@kernel/ui/testing'
import { createClientIdentity, installClientIdentity, type SessionHandle } from '@client/connections'
import type { PanelRecord } from '@workspace/document/contract'
import { installBrowserPageBridge, installBrowserPartitions } from '@services/browser/client'
import type { BrowserOp, BrowserSnapshot, BrowserTab } from '../contract'
import BrowserView from './BrowserView'
import { pageHostFor } from './surfaces'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tab = (patch: Partial<BrowserTab> = {}): BrowserTab => ({ id: 't1', url: 'cate://newtab', title: '', favicon: null, pinned: false, nav: 0, navSource: null, ...patch })
const snapshotOf = (tabs: BrowserTab[], patch: Partial<BrowserSnapshot> = {}): BrowserSnapshot => ({
  tabs, activeTabId: tabs[0].id, viewport: { preset: 'compact' }, zoom: 1,
  canGoBack: false, canGoForward: false, isLoading: false, loadError: null, crashed: false, downloads: [], agentCursor: null,
  ...patch,
})

let host: HTMLDivElement
let root: Root
let restoreRuntime: () => void
const send = vi.fn(async (_op: BrowserOp) => undefined)
const record: PanelRecord = { id: 'p1', type: 'browser', title: 'Browser', fields: {} }
const session = {} as SessionHandle<BrowserSnapshot>

function render(snapshot: BrowserSnapshot | null, props: { focused?: boolean } = {}) {
  act(() => root.render(
    <BrowserView workspaceId="ws" panelId="p1" record={record} session={session} send={send}
      snapshot={snapshot} visible focused={props.focused ?? false} />,
  ))
}

beforeEach(() => {
  send.mockClear()
  installMockClientUi()
  installClientIdentity(createClientIdentity({ device: { name: 'test', keyFingerprint: 'f' }, features: ['webview', 'pageDriver'] }))
  installBrowserPartitions((workspaceId) => `persist:ws-${workspaceId}-runtime`)
  installBrowserPageBridge({
    attach: vi.fn(async () => {}),
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

afterEach(() => {
  act(() => root.unmount())
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

  it('renders the start page over a blank guest in the workspace partition', () => {
    render(snapshotOf([tab()]))
    expect(host.textContent).toContain('Enter a URL to open a page')
    const slot = host.querySelector('[data-browser-webview-slot]')!
    expect(slot.getAttribute('data-browser-src')).toBe('about:blank')
    expect(slot.getAttribute('data-browser-partition')).toBe('persist:ws-ws-runtime')
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
    expect(send).toHaveBeenCalledWith({ kind: 'navigate', input: 'example.com' })
  })

  it('sends tab ops from the tab strip', () => {
    render(snapshotOf([tab(), tab({ id: 't2', url: 'https://b.test/', title: 'B' })]))
    const second = host.querySelector<HTMLElement>('[title^="B ·"]')
    act(() => second?.click())
    expect(send).toHaveBeenCalledWith({ kind: 'selectTab', tabId: 't2' })
  })

  it('renders internal pages instead of a webview', async () => {
    render(snapshotOf([tab({ url: 'chrome://history/' })]))
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[data-browser-history]')).not.toBeNull()
    expect(host.querySelector('[data-browser-webview-slot]')).toBeNull()
  })

  it('registers its pages for page operations when this client drives pages', () => {
    render(snapshotOf([tab()]))
    expect(pageHostFor('ws', 'p1')).toBeDefined()
    act(() => root.unmount())
    expect(pageHostFor('ws', 'p1')).toBeUndefined()
    root = createRoot(host)
  })

  it('hands the page back from the agent on user input', () => {
    const agentCursor = { event: { kind: 'click' as const, label: 'click', x: 1, y: 2, toX: null, toY: null }, serial: 1 }
    render(snapshotOf([tab()], { agentCursor }))
    act(() => { host.querySelector('[data-browser-toolbar]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    expect(send).toHaveBeenCalledWith({ kind: 'releaseAgentCursor' })
  })
})
