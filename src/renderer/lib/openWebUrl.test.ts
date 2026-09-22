import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('./terminal/terminalRegistry', () => ({
  terminalRegistry: { dispose: vi.fn(), disposeWorkspace: vi.fn(), getEntry: vi.fn(), has: vi.fn(() => false) },
}))
import { useAppStore } from '../stores/appStore'
import { getOrCreateWorkspaceDockStore, releaseWorkspaceDockStore } from './workspace/dockRegistry'
import { openWebUrl } from './openWebUrl'

beforeEach(() => {
  vi.stubGlobal('window', { electronAPI: {} })
  for (const ws of useAppStore.getState().workspaces) releaseWorkspaceDockStore(ws.id)
  useAppStore.setState({ workspaces: [], selectedWorkspaceId: '' })
})

it('opens web links in a visible browser without requiring a project folder', () => {
  const id = openWebUrl('https://example.com/a?b=c#d')!
  const app = useAppStore.getState()
  const ws = app.getWorkspace(app.selectedWorkspaceId)!
  expect(ws.rootPath).toBe('')
  expect(ws.panels[id].tabs?.[0].url).toBe('https://example.com/a?b=c#d')
  expect(getOrCreateWorkspaceDockStore(ws.id).getState().getPanelLocation(id)?.type).toBe('dock')
  const second = openWebUrl('http://localhost:8080')!
  expect(useAppStore.getState().workspaces).toHaveLength(1)
  expect(useAppStore.getState().getWorkspace(ws.id)?.panels[second].type).toBe('browser')
})

it('does not create a workspace or panel for unsupported schemes', () => {
  expect(openWebUrl('file:///tmp/test.html')).toBeNull()
  expect(openWebUrl('javascript:alert(1)')).toBeNull()
  expect(useAppStore.getState().workspaces).toEqual([])
})
