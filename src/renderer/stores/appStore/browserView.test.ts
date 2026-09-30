// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from './index'

const initialState = useAppStore.getState()
afterEach(() => useAppStore.setState(initialState, true))

it('stores browser zoom and viewport, leaving defaults unset', () => {
  useAppStore.setState({
    workspaces: [{ id: 'ws', name: 'Workspace', color: '', rootPath: '/repo', panels: {} }],
    selectedWorkspaceId: 'ws',
  } as never)
  const app = useAppStore.getState()
  const id = app.createBrowser('ws', 'https://example.test', undefined, { target: 'none' })
  const panel = () => useAppStore.getState().workspaces[0].panels[id]

  app.updatePanelBrowserView('ws', id, { zoom: 1.5, viewport: { preset: 'desktop', width: 1280, height: 800 } })
  expect(panel()).toMatchObject({ browserZoom: 1.5, browserViewport: { preset: 'desktop', width: 1280, height: 800 } })

  app.updatePanelBrowserView('ws', id, { zoom: 1 })
  expect(panel().browserZoom).toBeUndefined()
  expect(panel().browserViewport).toEqual({ preset: 'desktop', width: 1280, height: 800 })

  app.updatePanelBrowserView('ws', id, { viewport: { preset: 'compact' } })
  expect(panel().browserViewport).toBeUndefined()
})
