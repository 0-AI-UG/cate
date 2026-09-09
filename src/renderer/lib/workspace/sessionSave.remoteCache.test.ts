// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import { useWorkspaceTrustStore } from '../../stores/workspaceTrustStore'
import { saveSession } from './sessionSave'
import { loadSession } from './sessionLoad'
import type { RemoteProjectEntry } from '../../../shared/types'
vi.mock('../logger', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
let entries: RemoteProjectEntry[] = []
const root = 'cate-runtime://cache-server/outside/proj'
const detached = { windowId: 'dock-remote', workspaceId: 'remote-ws', panels: { detached: { id: 'detached', type: 'editor', title: 'Dirty', isDirty: true, unsavedContent: 'recover me' } }, dockState: { center: { type: 'tabs', id: 'tabs', panelIds: ['detached'], activeIndex: 0 } }, canvasStates: {}, bounds: { x: 0, y: 0, width: 800, height: 600 } }
beforeEach(() => {
  entries = []
  useWorkspaceTrustStore.setState({ trusted: [root], hydrated: true, queue: [] })
  useAppStore.setState({ workspaces: [{ id: 'remote-ws', name: 'Remote', rootPath: root, color: '', panels: {}, connection: { kind: 'server', runtimeId: 'cache-server', remotePath: '/outside/proj', host: 'example', user: 'me' } }], selectedWorkspaceId: 'remote-ws' } as never)
  Object.assign(window, { electronAPI: {
    dockWindowsList: vi.fn(async () => [detached]), projectStateSave: vi.fn(async () => {}),
    remoteProjectsSet: vi.fn(async (value: RemoteProjectEntry[]) => { entries = structuredClone(value) }),
    remoteProjectsGet: vi.fn(async () => entries), recentProjectsGet: vi.fn(async () => []),
    sidebarSessionSet: vi.fn(async () => {}), sidebarSessionGet: vi.fn(async () => null),
  } })
})
it('restores a remote detached editor from the same session representation after startup', async () => {
  await saveSession()
  const restored = await loadSession()
  expect(restored?.dockWindows?.[0]?.panels.detached.unsavedContent).toBe('recover me')
  expect(entries[0]).toHaveProperty('cache.version', 1)
})
