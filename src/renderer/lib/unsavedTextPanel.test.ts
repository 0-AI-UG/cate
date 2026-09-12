// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../../shared/types'

const mocks = vi.hoisted(() => ({
  requestPanelTarget: vi.fn(),
  createInteractivePanel: vi.fn(() => 'preview-panel'),
}))

vi.mock('./panelTargetPicker', () => ({ requestPanelTarget: mocks.requestPanelTarget }))
vi.mock('./panels/createInteractivePanel', () => ({ createInteractivePanel: mocks.createInteractivePanel }))

import { useAppStore } from '../stores/appStore'
import { openUnsavedTextPanel } from './unsavedTextPanel'

let initialState: ReturnType<typeof useAppStore.getState>

beforeEach(() => {
  initialState = useAppStore.getState()
  useAppStore.setState({
    selectedWorkspaceId: 'ws',
    workspaces: [{
      id: 'ws', name: 'Workspace', color: '#000', rootPath: '/repo',
      panels: { agent: { id: 'agent', type: 'agent', title: 'Agent', isDirty: false } },
    } as WorkspaceState],
  })
  mocks.requestPanelTarget.mockReset().mockResolvedValue({
    kind: 'new',
    placement: { target: 'dock', zone: 'center' },
  })
  mocks.createInteractivePanel.mockClear().mockImplementation(() => {
    useAppStore.getState().addPanel('ws', {
      id: 'preview-panel', type: 'editor', title: 'Untitled', isDirty: false,
    })
    return 'preview-panel'
  })
})

afterEach(() => useAppStore.setState(initialState, true))

describe('openUnsavedTextPanel', () => {
  it('places an untitled editor and populates its unsaved buffer', async () => {
    await expect(openUnsavedTextPanel({
      workspaceId: 'ws', sourcePanelId: 'agent', title: 'Context.md', content: 'exact context',
    })).resolves.toBe('preview-panel')

    expect(mocks.requestPanelTarget).toHaveBeenCalledWith({
      workspaceId: 'ws', sourcePanelId: 'agent', panelType: 'editor', availability: 'new',
    })
    expect(mocks.createInteractivePanel).toHaveBeenCalledWith(
      'editor',
      { workspaceId: 'ws', placement: { target: 'dock', zone: 'center' } },
      expect.objectContaining({ id: 'agent' }),
    )
    expect(useAppStore.getState().workspaces[0].panels['preview-panel']).toMatchObject({
      title: 'Context.md', isDirty: true, unsavedContent: 'exact context',
    })
    expect(useAppStore.getState().workspaces[0].panels['preview-panel'].filePath).toBeUndefined()
  })

  it('does not create an editor when placement is cancelled', async () => {
    mocks.requestPanelTarget.mockResolvedValueOnce(null)
    await expect(openUnsavedTextPanel({
      workspaceId: 'ws', title: 'Context.md', content: 'context',
    })).resolves.toBeNull()
    expect(mocks.createInteractivePanel).not.toHaveBeenCalled()
  })
})
