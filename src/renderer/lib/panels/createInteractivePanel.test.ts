// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { getPanelDef } from '../../panels/registry'
import { useAppStore } from '../../stores/appStore'

const original = useAppStore.getState()
beforeEach(() => useAppStore.setState({ selectedWorkspaceId: 'create', workspaces: [{ id: 'create', name: 'Create', color: '', rootPath: '/repo', panels: {}, worktrees: [{ id: 'branch', path: '/branch', color: '' }] }] }))
afterEach(() => useAppStore.setState(original, true))
it.each(['terminal', 'agent', 'editor'] as const)('registry preserves explicit checkout context for %s creation', (type) => {
  const id = getPanelDef(type).create({ workspaceId: 'create', placement: { target: 'none' }, cwd: '/branch/subdir', worktreeId: 'branch' } as Parameters<ReturnType<typeof getPanelDef>['create']>[0])!
  const panel = useAppStore.getState().getWorkspace('create')!.panels[id]
  expect(panel.worktreeId).toBe('branch')
  if (type !== 'editor') expect(panel.cwd).toBe('/branch/subdir')
})
