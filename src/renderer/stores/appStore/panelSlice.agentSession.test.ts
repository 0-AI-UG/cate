// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../../../shared/types'

vi.mock('../../lib/logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}))
vi.mock('../../lib/terminal/terminalRegistry', () => ({
  terminalRegistry: {
    setPendingRestore: vi.fn(),
    dispose: vi.fn(),
    disposeWorkspace: vi.fn(),
    getEntry: vi.fn(),
    has: vi.fn(() => false),
  },
}))

import { useAppStore } from '../appStore'

const workspaceId = 'workspace'
const panelId = 'terminal'

function workspace(): WorkspaceState {
  return {
    id: workspaceId,
    name: 'Workspace',
    color: '',
    rootPath: '/tmp/workspace',
    panels: {
      [panelId]: {
        id: panelId,
        type: 'terminal',
        title: 'Terminal',
        isDirty: false,
        agentSession: {
          agentId: 'hermes',
          sessionId: 'session-1',
          cwd: '/tmp/workspace',
          profile: 'work',
        },
      },
    },
  } as WorkspaceState
}

describe('setPanelAgentSession', () => {
  beforeEach(() => {
    useAppStore.setState({ workspaces: [workspace()], selectedWorkspaceId: workspaceId })
  })

  it('applies a profile-only identity change', () => {
    useAppStore.getState().setPanelAgentSession(workspaceId, panelId, {
      agentId: 'hermes',
      sessionId: 'session-1',
      cwd: '/tmp/workspace',
      profile: 'default',
    })

    expect(useAppStore.getState().workspaces[0]?.panels[panelId]?.agentSession?.profile)
      .toBe('default')
  })
})
