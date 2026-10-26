import { afterEach, expect, it } from 'vitest'
import type { WorkspaceList } from '@client/workspaces'
import { installClientApp, type ClientApp } from './app'
import { installNavigationHooks, openUrl } from './navigation'
import { INITIAL_UI_STATE, useUIStore } from './state/uiStore'
import { noRuntimeUpdates } from '@client/connections/testing'

afterEach(() => useUIStore.setState(INITIAL_UI_STATE))

it('a pairing link opened with the app fills in Join with a Code', () => {
  openUrl('cate://pair?r=abc&s=def')
  expect(useUIStore.getState().joinDialog).toEqual({ code: 'cate://pair?r=abc&s=def' })
})

it('a shown workspace that leaves the list is not shown any more', () => {
  let entries = [{ id: 'local:/a' }]
  const listeners = new Set<() => void>()
  installClientApp({
    runtimeUpdates: noRuntimeUpdates,
    workspaces: {
      get: (id: string) => entries.find((e) => e.id === id),
      subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) },
      getSnapshot: () => ({ entries, open: [] }),
      close: () => {},
    } as unknown as WorkspaceList,
    connections: {} as ClientApp['connections'],
    version: '2.0.5',
  })
  const stop = installNavigationHooks()
  useUIStore.getState().setSelectedWorkspace('local:/a')
  entries = []
  for (const l of listeners) l()
  expect(useUIStore.getState().selectedWorkspaceId).toBeNull()
  stop()
  installClientApp(null)
})
