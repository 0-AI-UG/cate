// A canvas swept out of the dock closes fully, so its child panels go with it.

// @vitest-environment jsdom

import { it, expect, vi } from 'vitest'

const teardown = vi.hoisted(() => vi.fn((id: string) => new Set(id === 'canvas' ? ['child'] : [])))
vi.mock('../../lib/panels/panelLifecycle', () => ({ teardownPanelFamily: teardown }))

import { useAppStore } from '.'

it('closes an orphaned canvas together with its children', () => {
  useAppStore.setState({
    selectedWorkspaceId: 'ws',
    workspaces: [{ id: 'ws', name: 'ws', color: '', rootPath: '/ws', panels: {
      canvas: { id: 'canvas', type: 'canvas', title: 'Canvas' },
      child: { id: 'child', type: 'terminal', title: 'Terminal' },
    } }] as never,
  })
  useAppStore.getState().reconcileWorkspaceDock('ws')
  expect(teardown).toHaveBeenCalledWith('canvas', 'canvas', 'close', expect.any(Function), undefined)
  expect(useAppStore.getState().workspaces[0].panels).toEqual({})
})
