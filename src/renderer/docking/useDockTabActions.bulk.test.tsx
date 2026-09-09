import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('../lib/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/terminal/terminalRegistry', () => ({ terminalRegistry: { release: vi.fn() } }))
import { useDockTabActions } from './useDockTabActions'
import { CanvasStoreProvider } from '../stores/CanvasStoreContext'
import { createDockStore } from '../stores/dockStore'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(['close-all', 'close-others', 'close-right'])('routes %s through one aggregate operation', async (operation) => {
  const closeOne = vi.fn()
  const closeMany = vi.fn().mockResolvedValue(false)
  const originalApi = window.electronAPI
  window.electronAPI = { ...originalApi, showContextMenu: vi.fn().mockResolvedValue(operation) }
  let actions!: ReturnType<typeof useDockTabActions>
  function Harness() {
    actions = useDockTabActions({
      stack: { type: 'tabs', id: 'stack', panelIds: ['p1', 'p2'], activeIndex: 0 },
      zone: 'center', dockStoreApi: createDockStore(), workspaceId: 'ws',
      getPanelProp: () => undefined, onClosePanel: closeOne, onClosePanels: closeMany,
    })
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<CanvasStoreProvider store={getOrCreateCanvasStoreForPanel('bulk-test')}><Harness /></CanvasStoreProvider>))
    await act(async () => {
      await actions.handleTabContextMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as never, 'p1')
    })
    expect(closeMany).toHaveBeenCalledExactlyOnceWith(operation === 'close-all' ? ['p1', 'p2'] : ['p2'])
    expect(closeOne).not.toHaveBeenCalled()
  } finally {
    act(() => root.unmount())
    releaseCanvasStoreForPanel('bulk-test')
    window.electronAPI = originalApi
  }
})
