// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type WorkspaceState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { AgentHooksSettings } from './AgentHooksSettings'
import { SettingsSearchContext } from './SettingsSearchContext'

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

  it('shows a neutral status when Auto has no agent config folder', async () => {
    inspect.mockResolvedValue([])

    await act(async () => {
      root.render(<AgentHooksSettings />)
      await Promise.resolve()
    })

    expect(host.textContent).toContain(
      'Not configured in this workspace',
    )
  })

  it('shows when explicitly enabled hooks will be installed', async () => {
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
    expect(claudeRow?.textContent).toContain('Will install when a terminal opens')
  })

  it('is discoverable when settings search is filtered to Kiro', async () => {
    inspect.mockResolvedValue([])

    await act(async () => {
      root.render(
        <SettingsSearchContext.Provider value={{ query: 'kiro', sectionMatched: false }}>
          <AgentHooksSettings />
        </SettingsSearchContext.Provider>,
      )
      await Promise.resolve()
    })

    expect(host.querySelector('[data-srow]')).not.toBeNull()
  })

  it.each([
    ['automatic', 'Automatic'], ['manual', 'Manual'], ['unknown', 'Unknown'],
  ])('shows a short read-only approval label for %s', async (mode, label) => {
    inspect.mockResolvedValue([{
      agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true,
      approvalDetection: { source: 'config', mode, detail: '/home/test/.codex/config.toml' },
    }])
    await act(async () => { root.render(<AgentHooksSettings />) })
    expect(host.textContent).toContain(`Approvals: ${label}`)
    expect(host.textContent).not.toContain('/home/test/.codex/config.toml')
    expect(host.querySelector('[title="/home/test/.codex/config.toml"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Codex approval mode"]')).toBeNull()
    expect(host.querySelector('[aria-label="Codex hooks"]')).not.toBeNull()
    expect(window.electronAPI.settingsSet).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('human permission-prompt notification')
  })

  it('refreshes detected configuration', async () => {
    inspect.mockResolvedValue([])
    await act(async () => { root.render(<AgentHooksSettings />) })
    expect(host.textContent).toContain('Approvals: Unknown')
    inspect.mockResolvedValue([{
      agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true,
      approvalDetection: { source: 'config', mode: 'manual', detail: 'Codex default: approvals_reviewer = user' },
    }])
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Refresh detection')!.click() })
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Approvals: Manual')
    expect(window.electronAPI.settingsSet).not.toHaveBeenCalled()
  })
})
