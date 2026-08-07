import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from './index'

const initialState = useAppStore.getState()

describe('coding-agent terminal titles', () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [{
        id: 'ws',
        name: 'Workspace',
        color: '',
        rootPath: '/repo',
        panels: {},
      }],
      selectedWorkspaceId: 'ws',
    } as never)
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('uses the worker role as the canonical title and keeps agent detection from replacing it', () => {
    const panelId = useAppStore.getState().createTerminal(
      'ws',
      undefined,
      undefined,
      { target: 'none' },
      '/repo',
      {
        runId: 'run-1',
        agentId: 'codex',
        title: 'Integration tests',
        prompt: 'Add integration tests',
        ownerPanelId: 'supervisor',
      },
    )

    expect(useAppStore.getState().workspaces[0].panels[panelId].title)
      .toBe('Integration tests')

    useAppStore.getState().updatePanelTitleFromAgent('ws', panelId, 'Codex')

    expect(useAppStore.getState().workspaces[0].panels[panelId].title)
      .toBe('Integration tests')
  })
})
