import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import UsageOverview from './UsageOverview'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ getUrl: vi.fn(), closed: vi.fn() }))
// Global usage must not consult workspace state, even when none are open.
vi.mock('../stores/appStore', () => ({ useAppStore: () => { throw new Error('No workspace') } }))
vi.mock('../stores/uiStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ showUsage: true }) }))
vi.mock('../shells/LeftSidebarReopen', () => ({ LeftSidebarReopen: () => null, useLeftChromeInset: () => 0 }))
vi.mock('../lib/themeManager', () => ({ getActiveTheme: vi.fn(), subscribeTheme: () => () => {} }))

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  mocks.getUrl.mockReset().mockResolvedValue({ error: 'Harness unavailable' })
  mocks.closed.mockReset()
  Object.assign(window, { electronAPI: { agentHarnessGetUsageUrl: mocks.getUrl, agentHarnessPanelClosed: mocks.closed } })
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()) })

it('requests global usage without an open workspace', async () => {
  await act(async () => root.render(<UsageOverview />))
  expect(mocks.getUrl).toHaveBeenCalledExactlyOnceWith({ panelId: expect.stringMatching(/^usage-/) })
  expect(host.textContent).not.toContain('Open a workspace')
})

it('releases the usage panel when a pending request completes after unmount', async () => {
  let finish: (value: unknown) => void = () => {}
  mocks.getUrl.mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await act(async () => root.render(<UsageOverview />))
  const request = mocks.getUrl.mock.calls[0][0]
  await act(async () => root.render(null))
  await act(async () => finish({ url: 'http://127.0.0.1:4321/usage' }))
  expect(mocks.closed).toHaveBeenLastCalledWith(request)
})

it('explains when the running preload needs a restart', async () => {
  Object.assign(window, { electronAPI: { agentHarnessPanelClosed: mocks.closed } })
  await act(async () => root.render(<UsageOverview />))
  expect(host.textContent).toContain('Restart Cate')
  expect(host.textContent).not.toContain('Open a workspace')
})
