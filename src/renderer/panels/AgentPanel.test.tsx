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

vi.mock('./AgentWorkspaceBar', () => ({
  AgentWorkspaceBar: () => <div data-testid="workspace-bar">Workspace bar</div>,
}))

import { useAppStore } from '../stores/appStore'
import AgentPanel from './AgentPanel'

const initialState = useAppStore.getState()
let host: HTMLDivElement
let root: Root
let getPanelUrl: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  getPanelUrl = vi.fn()
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

describe('AgentPanel workspace bar', () => {
  it('stays available while the harness is starting', async () => {
    getPanelUrl.mockReturnValue(new Promise(() => {}))

    await act(async () => root.render(<AgentPanel panelId="agent" workspaceId="ws" />))

    expect(host.querySelector('[data-testid="workspace-bar"]')).not.toBeNull()
    expect(host.textContent).toContain('Starting agent')
  })

  it('stays available when the harness fails', async () => {
    getPanelUrl.mockResolvedValue({ error: 'runtime unavailable' })

    await act(async () => {
      root.render(<AgentPanel panelId="agent" workspaceId="ws" />)
      await Promise.resolve()
    })

    expect(host.querySelector('[data-testid="workspace-bar"]')).not.toBeNull()
    expect(host.textContent).toContain('Agent unavailable')
    expect(host.textContent).toContain('runtime unavailable')
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

    await act(async () => webview.dispatchEvent(new Event('did-start-loading')))
    expect(webview.classList.contains('invisible')).toBe(true)
  })
})
