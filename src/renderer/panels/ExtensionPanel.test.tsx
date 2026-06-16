// =============================================================================
// ExtensionPanel — resolves its proxy URL for the OWNING workspace. Regression:
// the panel used to read workspaceId from window.location.search, which is empty
// in the main window, so every reverse-API call (and the server's CATE_API
// session) resolved no workspace — storage returned `no-storage`, openFile /
// createPanel targeted nothing, and the page reported "no workspace selected".
// The workspaceId MUST come from the panel prop renderPanelComponent supplies.
// =============================================================================

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/portalRegistry', () => ({ portalRegistry: { register: vi.fn(), unregister: vi.fn() } }))

import ExtensionPanel from './ExtensionPanel'

const proxyUrl = vi.fn(async (_args: { extensionId: string; workspaceId: string; panelId: string }) => ({
  url: 'http://127.0.0.1:9/ext/tok/?x',
  preloadPath: '/p/cateHost.js',
}))
const panelClosed = vi.fn()

let container: HTMLDivElement
let root: Root

function mount(props: { workspaceId: string }): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    extensionProxyUrl: proxyUrl,
    extensionPanelClosed: panelClosed,
    extensionServerRestart: vi.fn(async () => undefined),
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      <ExtensionPanel
        panelId="panel-1"
        workspaceId={props.workspaceId}
        extensionId="cate.kitchensink"
        extensionPanelId="main"
      />,
    )
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Simulate the real main window: a query string that does NOT carry workspaceId.
  window.history.replaceState({}, '', '/index.html?window=main')
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('ExtensionPanel', () => {
  it('resolves the proxy URL with the prop workspaceId, not the (empty) URL param', async () => {
    mount({ workspaceId: 'ws-real-123' })
    // Let the resolve effect's promise settle.
    await act(async () => { await Promise.resolve() })

    expect(proxyUrl).toHaveBeenCalledTimes(1)
    expect(proxyUrl).toHaveBeenCalledWith({
      extensionId: 'cate.kitchensink',
      workspaceId: 'ws-real-123',
      panelId: 'panel-1',
    })
    // Guard the exact regression: never the empty string the URL param would give.
    expect(proxyUrl.mock.calls[0][0].workspaceId).not.toBe('')
  })

  it('reports the panel closed for the same workspace on unmount', async () => {
    mount({ workspaceId: 'ws-real-123' })
    await act(async () => { await Promise.resolve() })
    act(() => { root.unmount() })
    expect(panelClosed).toHaveBeenCalledWith({
      extensionId: 'cate.kitchensink',
      workspaceId: 'ws-real-123',
      panelId: 'panel-1',
    })
    // Re-mount a throwaway so afterEach's unmount has a live root.
    mount({ workspaceId: 'ws-real-123' })
  })
})
