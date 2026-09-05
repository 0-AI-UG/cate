// @vitest-environment jsdom

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

import { useAppStore } from '../stores/appStore'
import AgentPanel from './AgentPanel'
import { useActivePanelStore } from '../lib/activePanel'
import { useUIStore } from '../stores/uiStore'

const initialState = useAppStore.getState()
let host: HTMLDivElement
let root: Root
let getPanelUrl: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  getPanelUrl = vi.fn()
  useActivePanelStore.setState({ activePanelId: null })
  useUIStore.setState({ showCommandPalette: false })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agentHarnessGetPanelUrl: getPanelUrl,
    agentHarnessPanelClosed: vi.fn(),
    agentHarnessRestart: vi.fn(),
  }
  useAppStore.setState({
    ...initialState,
    selectedWorkspaceId: 'ws',
    workspaces: [{
      id: 'ws',
      name: 'Repo',
      color: '',
      rootPath: '/repo',
      panels: {
        agent: { id: 'agent', type: 'agent', title: 'Agent', isDirty: false },
      },
    }],
  }, true)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('AgentPanel', () => {
  it('shows loading feedback while the harness is starting', async () => {
    getPanelUrl.mockReturnValue(new Promise(() => {}))

    await act(async () => root.render(<AgentPanel panelId="agent" workspaceId="ws" />))

    expect(host.textContent).toContain('Starting T3 Code')
  })

  it('shows an error when the harness fails', async () => {
    getPanelUrl.mockResolvedValue({ error: 'runtime unavailable' })

    await act(async () => {
      root.render(<AgentPanel panelId="agent" workspaceId="ws" />)
      await Promise.resolve()
    })

    expect(host.textContent).toContain('T3 Code unavailable')
    expect(host.textContent).toContain('runtime unavailable')
  })

  it('loads a chat selected in the host into the same panel', async () => {
    getPanelUrl.mockImplementation(({ threadId }) => Promise.resolve({
      url: `http://127.0.0.1:49152/local-env/${threadId ?? 'new'}`,
      partition: 'persist:t3-test', runtimeId: 'local', environmentId: 'local-env',
    }))
    await act(async () => root.render(<AgentPanel panelId="agent" workspaceId="ws" />))
    await act(async () => useAppStore.getState().setPanelAgentThreadId('ws', 'agent', 'saved-chat'))
    expect(getPanelUrl).toHaveBeenLastCalledWith(expect.objectContaining({ panelId: 'agent', threadId: 'saved-chat' }))
    expect(host.querySelector('webview')?.getAttribute('src')).toBe('http://127.0.0.1:49152/local-env/saved-chat')
    await act(async () => useAppStore.getState().setPanelAgentThreadId('ws', 'agent', undefined))
    expect(host.querySelector('webview')?.getAttribute('src')).toBe('http://127.0.0.1:49152/local-env/new')
  })

  it('persists guest-created chats without reloading the guest', async () => {
    getPanelUrl.mockResolvedValue({
      url: 'http://127.0.0.1:49152/', partition: 'persist:t3-test', runtimeId: 'local', environmentId: 'local-env',
    })
    await act(async () => root.render(<AgentPanel panelId="agent" workspaceId="ws" />))
    const webview = host.querySelector('webview')!
    await act(async () => webview.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), {
      url: 'http://127.0.0.1:49152/local-env/created-chat',
    })))
    expect(useAppStore.getState().workspaces[0].panels.agent.agentThreadId).toBe('created-chat')
    expect(getPanelUrl).toHaveBeenCalledTimes(1)
    expect(host.querySelector('webview')).toBe(webview)
  })

  it('does not reveal upstream UI before Cate branding is applied', async () => {
    getPanelUrl.mockResolvedValue({
      url: 'http://127.0.0.1:49152/',
      partition: 'persist:t3-test',
      runtimeId: 'local',
      environmentId: 'local-env',
    })

    await act(async () => {
      root.render(<AgentPanel panelId="agent" workspaceId="ws" />)
      await Promise.resolve()
    })

    const webview = host.querySelector('webview') as HTMLElement & {
      getURL: () => string
      insertCSS: ReturnType<typeof vi.fn>
      executeJavaScript: ReturnType<typeof vi.fn>
      loadURL: ReturnType<typeof vi.fn>
    }
    let finishCss: (() => void) | undefined
    webview.getURL = () => 'http://127.0.0.1:49152/'
    webview.insertCSS = vi.fn(() => new Promise<string>((resolve) => {
      finishCss = () => resolve('css-key')
    }))
    webview.executeJavaScript = vi.fn().mockResolvedValue(undefined)
    webview.loadURL = vi.fn().mockResolvedValue(undefined)

    expect(webview.classList.contains('invisible')).toBe(true)
    await act(async () => webview.dispatchEvent(new Event('dom-ready')))
    expect(webview.classList.contains('invisible')).toBe(true)

    await act(async () => {
      finishCss?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(webview.classList.contains('visible')).toBe(true)

    await act(async () => webview.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: true })))
    expect(webview.classList.contains('visible')).toBe(true)

    const focus = vi.spyOn(webview, 'focus')
    await act(async () => {
      useUIStore.setState({ showCommandPalette: true })
      useActivePanelStore.setState({ activePanelId: 'agent' })
    })
    expect(focus).not.toHaveBeenCalled()
    await act(async () => useUIStore.setState({ showCommandPalette: false }))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    expect(focus).toHaveBeenCalledOnce()


    await act(async () => webview.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: false })))
    expect(webview.classList.contains('invisible')).toBe(true)
  })
})

it('uses only the bound connected thread title, preserves user titles, and ignores an old guest after switching', async () => {
  vi.useFakeTimers()
  try {
    useAppStore.getState().setPanelAgentThreadId('ws', 'agent', 'first')
    getPanelUrl.mockResolvedValue({ url: 'http://127.0.0.1:49152/local-env/first', partition: 'persist:title-test', runtimeId: 'local', environmentId: 'local-env' })
    await act(async () => root.render(<AgentPanel panelId="agent" workspaceId="ws" />))
    const guest = host.querySelector('webview')! as HTMLElement & { getURL: () => string; insertCSS: ReturnType<typeof vi.fn>; executeJavaScript: ReturnType<typeof vi.fn> }
    let snapshot = { connected: true, revision: 1, threads: { first: { id: 'first', title: 'Extracted title' }, other: { id: 'other', title: 'Wrong conversation' } } }
    guest.getURL = () => 'http://127.0.0.1:49152/local-env/first'
    guest.insertCSS = vi.fn().mockResolvedValue('css')
    guest.executeJavaScript = vi.fn(async (script: string) => script.startsWith('window.__cateT3Threads &&') ? snapshot : undefined)
    const title = () => useAppStore.getState().workspaces[0].panels.agent.title
    await act(async () => guest.dispatchEvent(new Event('dom-ready')))
    expect(title()).toBe('Extracted title')
    snapshot = { ...snapshot, connected: false, revision: 2, threads: { ...snapshot.threads, first: { id: 'first', title: 'Stale title' } } }
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(title()).toBe('Extracted title')
    snapshot = { ...snapshot, connected: true, revision: 3, threads: { ...snapshot.threads, first: { id: 'first', title: '' } } }
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(title()).toBe('Extracted title')
    await act(async () => useAppStore.getState().renamePanelByUser('ws', 'agent', 'My chosen title'))
    snapshot = { ...snapshot, revision: 4, threads: { ...snapshot.threads, first: { id: 'first', title: 'New generated title' } } }
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(title()).toBe('My chosen title')
    let release: ((value: unknown) => void) | undefined
    guest.executeJavaScript.mockImplementation((script: string) => script.startsWith('window.__cateT3Threads &&') ? new Promise(resolve => { release = resolve }) : Promise.resolve())
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(release).toBeDefined()
    await act(async () => useAppStore.getState().setPanelAgentThreadId('ws', 'agent', 'other'))
    const update = vi.spyOn(useAppStore.getState(), 'updatePanelTitleFromAgent')
    await act(async () => release!(snapshot))
    expect(update).not.toHaveBeenCalled()
    update.mockRestore()
  } finally {
    vi.useRealTimers()
  }
})
