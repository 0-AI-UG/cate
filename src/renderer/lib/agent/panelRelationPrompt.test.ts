// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { consumePanelRelationContextForSend, panelRelationContextForSend } from './panelRelationPrompt'

const workspace = {
  id: 'ws',
  name: 'Workspace',
  color: '#000000',
  rootPath: '/repo',
  panels: {
    source: { id: 'source', type: 'agent', title: 'Agent', isDirty: false },
    browser: { id: 'browser', type: 'browser', title: 'Browser', isDirty: false },
  },
  panelRelations: [{ id: 'relation', fromPanelId: 'source', toPanelId: 'browser', kind: 'use' }],
} as WorkspaceState

let initialState: ReturnType<typeof useAppStore.getState>
let initialSettingsState: ReturnType<typeof useSettingsStore.getState>

beforeEach(() => {
  initialState = useAppStore.getState()
  initialSettingsState = useSettingsStore.getState()
  useAppStore.setState({ selectedWorkspaceId: 'ws', workspaces: [workspace] })
  useSettingsStore.setState({ panelRelationsEnabled: true })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  useSettingsStore.setState(initialSettingsState, true)
})

describe('one-shot panel relation context', () => {
  it('disarms context after returning it once', () => {
    expect(consumePanelRelationContextForSend('ws', 'source')).toContain('Browser')
    expect(useAppStore.getState().workspaces[0].panels.source.panelRelationContextMode).toBe('off')
    expect(panelRelationContextForSend('ws', 'source')).toBeNull()
  })

  it('does not change the toggle when there is no context to consume', () => {
    expect(consumePanelRelationContextForSend('ws', 'browser')).toBeNull()
    expect(useAppStore.getState().workspaces[0].panels.browser.panelRelationContextMode).toBeUndefined()
  })

  it('adds Codex execution guidance based on provider identity', () => {
    expect(panelRelationContextForSend('ws', 'source', 'codex')).toContain('outside the Codex sandbox')
    expect(panelRelationContextForSend('ws', 'source', 'codex')).toContain('`CATE_API` control endpoint')
    expect(panelRelationContextForSend('ws', 'source', 'claude-code')).not.toContain('cate-execution-guidance')
  })

  it('keeps always-on context armed after a send', () => {
    useAppStore.getState().setPanelRelationContextMode('ws', 'source', 'always')
    expect(consumePanelRelationContextForSend('ws', 'source')).toContain('Browser')
    expect(useAppStore.getState().workspaces[0].panels.source.panelRelationContextMode).toBe('always')
    expect(panelRelationContextForSend('ws', 'source')).toContain('Browser')
  })

  it('does not return context when the receiving agent has it turned off', () => {
    useAppStore.getState().setPanelRelationContextMode('ws', 'source', 'off')
    expect(consumePanelRelationContextForSend('ws', 'source')).toBeNull()
    expect(useAppStore.getState().workspaces[0].panels.source.panelRelationContextMode).toBe('off')
  })

  it('does not return or consume context when panel relations are disabled globally', () => {
    useSettingsStore.setState({ panelRelationsEnabled: false })

    expect(consumePanelRelationContextForSend('ws', 'source')).toBeNull()
    expect(useAppStore.getState().workspaces[0].panels.source.panelRelationContextMode).toBeUndefined()
  })
})
