import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { SettingsSearchContext } from '@kernel/ui'
import { workspaceSettingsTable, type WorkspaceSettings } from '@kernel/settings/contract'
import { fakeStream } from '../client/testing'
import { AgentHooksSettings } from './AgentHooksSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentHooksSettings', () => {
  let host: HTMLDivElement
  let root: Root
  let stop = () => {}
  let settingsStream: ReturnType<typeof fakeStream<ChannelEvent<WorkspaceSettings, Partial<WorkspaceSettings>>>>
  const inspectHooks = vi.fn()
  let rev = 1
  // Like the runtime: the change goes out before `set` answers.
  const set = vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    settingsStream.emit({ kind: 'change', rev: ++rev, change: { [key]: value } })
  })

  function install(agentHookInjection: WorkspaceSettings['agentHookInjection'] = {}) {
    settingsStream = fakeStream()
    rev = 1
    const runtime = {
      agents: { inspectHooks },
      settings: { set, subscribe: () => settingsStream.sub },
    }
    stop = setRuntimeResolver((id) => (id === 'ws' ? (runtime as never) : null))
    return () => settingsStream.emit({ kind: 'snapshot', rev: 1, snapshot: { ...workspaceSettingsTable.defaults, agentHookInjection } })
  }

  async function render(node: React.ReactNode, snapshot?: () => void) {
    await act(async () => {
      root.render(node)
      await Promise.resolve()
    })
    if (snapshot) act(() => snapshot())
  }

  beforeEach(() => {
    inspectHooks.mockReset()
    set.mockClear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    stop()
  })

  it('asks for a workspace without one', async () => {
    await render(<AgentHooksSettings workspaceId={null} />)
    expect(host.textContent).toContain('Open a workspace')
  })

  it('shows a neutral status when Auto has no agent config folder', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<AgentHooksSettings workspaceId="ws" />, install())
    expect(host.querySelector('[data-agent-hook-id="codex"]')?.textContent).toContain('Not configured in this workspace')
  })

  it('shows when explicitly enabled hooks will be installed', async () => {
    inspectHooks.mockResolvedValue([{ agentId: 'claude-code', displayName: 'Claude Code', folderPresent: false, injected: false }])
    await render(<AgentHooksSettings workspaceId="ws" />, install({ 'claude-code': 'on' }))
    expect(host.querySelector('[data-agent-hook-id="claude-code"]')?.textContent).toContain('Will install when a terminal opens')
  })

  it('writes the sparse per-agent mode to the workspace setting', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<AgentHooksSettings workspaceId="ws" />, install({ codex: 'off' }))
    const row = host.querySelector('[data-agent-hook-id="claude-code"]')!
    await act(async () => { row.querySelector<HTMLButtonElement>('[aria-pressed="false"][title^="Install"]')!.click() })
    expect(set).toHaveBeenCalledWith({ key: 'agentHookInjection', value: { codex: 'off', 'claude-code': 'on' } })

    const codex = host.querySelector('[data-agent-hook-id="codex"]')!
    expect(codex.textContent).toContain('Off for new terminals')
    await act(async () => { codex.querySelector<HTMLButtonElement>('[title^="Enable when"]')!.click() })
    expect(set).toHaveBeenLastCalledWith({ key: 'agentHookInjection', value: { 'claude-code': 'on' } })
  })

  it('shows an error when inspection fails', async () => {
    inspectHooks.mockRejectedValue(new Error('boom'))
    await render(<AgentHooksSettings workspaceId="ws" />, install())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not check agent hooks')
  })

  it('is discoverable when settings search is filtered to Kiro', async () => {
    inspectHooks.mockResolvedValue([])
    await render(
      <SettingsSearchContext.Provider value={{ query: 'kiro', sectionMatched: false }}>
        <AgentHooksSettings workspaceId="ws" />
      </SettingsSearchContext.Provider>,
      install(),
    )
    expect(host.querySelector('[data-srow]')).not.toBeNull()
  })

  it.each([
    ['automatic', 'Automatic'], ['manual', 'Manual'], ['unknown', 'Unknown'],
  ])('shows a short read-only approval label for %s', async (mode, label) => {
    inspectHooks.mockResolvedValue([{
      agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true,
      approvalDetection: { source: 'config', mode, detail: '/home/test/.codex/config.toml' },
    }])
    await render(<AgentHooksSettings workspaceId="ws" />, install())
    expect(host.textContent).toContain(`Approvals: ${label}`)
    expect(host.textContent).not.toContain('/home/test/.codex/config.toml')
    expect(host.querySelector('[title="/home/test/.codex/config.toml"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Codex approval mode"]')).toBeNull()
    expect(host.querySelector('[aria-label="Codex hooks"]')).not.toBeNull()
    expect(set).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('human permission-prompt notification')
  })

  it('refreshes detected configuration', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<AgentHooksSettings workspaceId="ws" />, install())
    expect(host.textContent).toContain('Approvals: Unknown')
    inspectHooks.mockResolvedValue([{
      agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true,
      approvalDetection: { source: 'config', mode: 'manual', detail: 'Codex default: approvals_reviewer = user' },
    }])
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Refresh detection')!.click() })
    expect(inspectHooks).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Approvals: Manual')
    expect(set).not.toHaveBeenCalled()
  })
})
