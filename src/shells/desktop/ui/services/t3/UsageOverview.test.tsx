// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { installT3WebviewHost } from '@services/t3/client'
import { UsageOverview } from './UsageOverview'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const panelUrl = vi.fn()
const setCookie = vi.fn(async () => {})
const target = {
  url: 'http://127.0.0.1:4321/usage', port: 4321, instanceId: 'i', environmentId: 'env', threadId: null,
  session: { name: 't3_session', value: 'secret' },
}

// The connection layer hands out one proxy per workspace.
const runtime = { t3: { panelUrl } } as unknown as RuntimeProxy
let host: HTMLDivElement
let root: Root
let stops: Array<() => void> = []
beforeEach(() => {
  panelUrl.mockReset().mockRejectedValue(new Error('Harness unavailable'))
  setCookie.mockClear()
  stops = [
    setRuntimeResolver((id) => id === 'ws' ? runtime : null),
    installT3WebviewHost({ partition: (id) => `persist:ws-${id}`, setCookie }),
  ]
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const stop of stops) stop()
})

it('asks for a workspace when none is open', async () => {
  await act(async () => root.render(<UsageOverview workspaceId={null} visible />))
  expect(host.textContent).toContain('Open a workspace')
  expect(panelUrl).not.toHaveBeenCalled()
})

it('loads the usage route in the workspace partition after installing the session cookie', async () => {
  panelUrl.mockResolvedValue(target)
  await act(async () => root.render(<UsageOverview workspaceId="ws" visible />))
  expect(panelUrl).toHaveBeenCalledWith({ route: 'usage' })
  expect(setCookie).toHaveBeenCalledWith('persist:ws-ws', 'http://127.0.0.1:4321', target.session)
  const webview = host.querySelector('webview')!
  expect(webview.getAttribute('src')).toBe(target.url)
  expect(webview.getAttribute('partition')).toBe('persist:ws-ws')
  expect(webview.getAttribute('data-usage-ready')).toBe('false')
})

it('shows the failure with a retry', async () => {
  await act(async () => root.render(<UsageOverview workspaceId="ws" visible />))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Harness unavailable')
  panelUrl.mockResolvedValue(target)
  await act(async () => (host.querySelector('[role="alert"] button') as HTMLButtonElement).click())
  expect(panelUrl).toHaveBeenCalledTimes(2)
  expect(host.querySelector('webview')).not.toBeNull()
})

it('shows the shared loading state while the usage surface starts', async () => {
  panelUrl.mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(<UsageOverview workspaceId="ws" visible header={<header><h1>Usage</h1></header>} />))
  expect(host.querySelector('header h1')?.textContent).toBe('Usage')
  expect(host.querySelector('[role="status"][aria-busy="true"]')?.textContent).toContain('Loading usage')
})
