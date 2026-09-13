// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { connectPanelToExisting } from './connectPanel'

const workspace = {
  id: 'ws',
  name: 'Workspace',
  color: '#000',
  rootPath: '/repo',
  panels: {
    agent: { id: 'agent', type: 'agent', title: 'Builder', isDirty: false },
    browser: { id: 'browser', type: 'browser', title: 'Preview', isDirty: false },
  },
} as WorkspaceState

let initialState: ReturnType<typeof useAppStore.getState>
let initialSettingsState: ReturnType<typeof useSettingsStore.getState>
const showContextMenu = vi.fn<(items: import('../../../shared/electron-api').NativeContextMenuItem[]) => Promise<string | null>>()

beforeEach(() => {
  initialState = useAppStore.getState()
  initialSettingsState = useSettingsStore.getState()
  useAppStore.setState({ selectedWorkspaceId: 'ws', workspaces: [workspace] })
  useSettingsStore.setState({ panelRelationsEnabled: true })
  showContextMenu.mockReset()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { showContextMenu },
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('connectPanelToExisting', () => {
  it('chooses a target and an explicit connection meaning', async () => {
    showContextMenu
      .mockResolvedValueOnce('target:browser')
      .mockResolvedValueOnce('kind:verify')

    const relationId = await connectPanelToExisting('ws', 'agent')

    expect(relationId).toBeTruthy()
    expect(showContextMenu.mock.calls[0][0]).toContainEqual({
      id: 'target:browser',
      label: 'Preview — browser',
    })
    expect(showContextMenu.mock.calls[1][0]).toContainEqual(expect.objectContaining({
      id: 'kind:verify',
      label: expect.stringContaining('Verify'),
    }))
    expect(showContextMenu.mock.calls[1][0]).toHaveLength(3)
    expect(showContextMenu.mock.calls[1][0].filter((item) => item.label?.includes('Recommended'))).toHaveLength(1)
    expect(useAppStore.getState().workspaces[0].panelRelations).toEqual([
      expect.objectContaining({
        id: relationId,
        fromPanelId: 'agent',
        toPanelId: 'browser',
        kind: 'verify',
      }),
    ])
  })

  it('allows an unanchored browser to start authoring a flow', async () => {
    showContextMenu
      .mockResolvedValueOnce('target:agent')
      .mockResolvedValueOnce('kind:context')

    const relationId = await connectPanelToExisting('ws', 'browser')

    expect(relationId).toBeTruthy()
    expect(useAppStore.getState().workspaces[0].panelRelations).toEqual([
      expect.objectContaining({
        id: relationId,
        fromPanelId: 'browser',
        toPanelId: 'agent',
        kind: 'context',
      }),
    ])
    expect(showContextMenu.mock.calls[1][0][0]).toEqual(expect.objectContaining({
      id: 'kind:context',
      label: expect.stringContaining('Send findings to'),
    }))
  })

  it('does not open menus or create a relation when disabled globally', async () => {
    useSettingsStore.setState({ panelRelationsEnabled: false })

    await expect(connectPanelToExisting('ws', 'agent')).resolves.toBeNull()
    expect(showContextMenu).not.toHaveBeenCalled()
    expect(useAppStore.getState().workspaces[0].panelRelations).toBeUndefined()
  })
})
