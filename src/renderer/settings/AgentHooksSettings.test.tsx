// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type WorkspaceState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { AgentHooksSettings } from './AgentHooksSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentHooksSettings', () => {
  let host: HTMLDivElement
  let root: Root
  const inspect = vi.fn()

  beforeEach(() => {
    inspect.mockReset()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agentHooksInspect: inspect,
        settingsSet: vi.fn(async () => {}),
      },
    })
    useSettingsStore.setState({ ...DEFAULT_SETTINGS, _loaded: true })
    useAppStore.setState({
      workspaces: [{ id: 'ws', rootPath: '/repo' } as WorkspaceState],
      selectedWorkspaceId: 'ws',
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState({ workspaces: [], selectedWorkspaceId: '' })
  })

  it('warns when Auto has no agent config folder to install into', async () => {
    inspect.mockResolvedValue([])

    await act(async () => {
      root.render(<AgentHooksSettings />)
      await Promise.resolve()
    })

    expect(host.textContent).toContain(
      "Hooks aren't installed. Auto waits for this agent's config folder; choose On to install them.",
    )
  })

  it('does not warn for an explicitly enabled agent', async () => {
    useSettingsStore.setState({
      agentHookInjection: { ws: { 'claude-code': 'on' } },
    })
    inspect.mockResolvedValue([
      {
        agentId: 'claude-code',
        displayName: 'Claude Code',
        folderPresent: false,
        injected: false,
      },
    ])

    await act(async () => {
      root.render(<AgentHooksSettings />)
      await Promise.resolve()
    })

    const claudeRow = host.querySelector('[data-agent-hook-id="claude-code"]')
    expect(claudeRow?.textContent).not.toContain("Hooks aren't installed.")
  })
})
