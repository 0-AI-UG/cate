// A workspace deleted in another window drops here with its panels.

// @vitest-environment jsdom

import { it, expect, vi } from 'vitest'

const teardown = vi.hoisted(() => vi.fn((_id: string) => new Set<string>()))
vi.mock('../../lib/panels/panelLifecycle', () => ({ teardownPanelFamily: teardown }))

import { useAppStore } from '.'

it('tears down the panels of workspaces main no longer lists, keeping the selected one', () => {
  const ws = (id: string) => ({ id, name: id, color: '', rootPath: `/${id}`, panels: { [`${id}-p`]: { id: `${id}-p`, type: 'terminal' } } })
  useAppStore.setState({ selectedWorkspaceId: 'kept', workspaces: [ws('kept'), ws('listed'), ws('gone')] as never })
  useAppStore.getState().mergeWorkspaceInfos([{ id: 'listed', name: 'listed', color: '', rootPath: '/listed' }] as never)
  expect(teardown.mock.calls.map(([id]) => id)).toEqual(['gone-p'])
  expect(useAppStore.getState().workspaces.map((w) => w.id)).toEqual(['kept', 'listed'])
})
