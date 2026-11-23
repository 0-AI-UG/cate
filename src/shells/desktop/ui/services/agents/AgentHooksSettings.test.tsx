import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import { AGENTS } from '@services/agents/contract'
import { workspaceSettingsTable, type WorkspaceSettings } from '@panels/settings'
import { fakeStream } from '@services/agents/client/testing'
import { AgentHookControl, useAgentHookSettings } from './AgentHooksSettings'

function HookHarness({ workspaceId }: { workspaceId: string | null }) {
  const controller = useAgentHookSettings(workspaceId)
  if (!controller.available) return <p>Open a workspace</p>
  return <div><button onClick={() => { void controller.refresh() }}>Refresh detection</button>{controller.error && <p role="alert">{controller.error}</p>}{AGENTS.map((agent) => <AgentHookControl key={agent.id} agentId={agent.id} name={agent.displayName} controller={controller} />)}</div>
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('agent activity controls', () => {
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
    if (snapshot) await act(async () => { snapshot() })
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
    await render(<HookHarness workspaceId={null} />)
    expect(host.textContent).toContain('Open a workspace')
  })

  it('shows a neutral status when Auto has no agent config folder', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<HookHarness workspaceId="ws" />, install())
    expect(host.querySelector('[data-agent-hook-id="codex"]')?.textContent).toContain('Not configured in this workspace')
  })

  it('shows when explicitly enabled hooks will be installed', async () => {
    inspectHooks.mockResolvedValue([{ agentId: 'claude-code', displayName: 'Claude Code', folderPresent: false, injected: false }])
    await render(<HookHarness workspaceId="ws" />, install({ 'claude-code': 'on' }))
    expect(host.querySelector('[data-agent-hook-id="claude-code"]')?.textContent).toContain('Will install when a terminal opens')
  })

  it('writes the sparse per-agent mode to the workspace setting', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<HookHarness workspaceId="ws" />, install({ codex: 'off' }))
    const row = host.querySelector('[data-agent-hook-id="claude-code"]')!
    await act(async () => { const select = row.querySelector('select')!; select.value = 'on'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(set).toHaveBeenCalledWith({ key: 'agentHookInjection', value: { codex: 'off', 'claude-code': 'on' } })

    const codex = host.querySelector('[data-agent-hook-id="codex"]')!
    expect(codex.textContent).toContain('Off for new terminals')
    await act(async () => { const select = codex.querySelector('select')!; select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(set).toHaveBeenLastCalledWith({ key: 'agentHookInjection', value: { 'claude-code': 'on' } })
  })

  it('shows an error when inspection fails', async () => {
    inspectHooks.mockRejectedValue(new Error('boom'))
    await render(<HookHarness workspaceId="ws" />, install())
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not check agent activity')
  })

  it('renders compact activity controls without repeating agent names or logos', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<HookHarness workspaceId="ws" />, install())
    expect(host.querySelectorAll('select')).toHaveLength(7)
    expect(host.querySelectorAll('img')).toHaveLength(0)
    expect(host.querySelector('[data-agent-hook-id="kiro"]')?.textContent).not.toContain('Kiro')
  })

  it('reports failed mode updates and restores the confirmed selection', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<HookHarness workspaceId="ws" />, install({ codex: 'off' }))
    set.mockRejectedValueOnce(new Error('refused'))
    await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="Codex integration"]')!; select.value = 'on'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not update agent activity')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Codex integration"]')?.value).toBe('off')
  })

  it.each([
    ['automatic', 'Automatic'], ['manual', 'Manual'], ['unknown', 'Unknown'],
  ])('shows a short read-only approval label for %s', async (mode, label) => {
    inspectHooks.mockResolvedValue([{
      agentId: 'codex', displayName: 'Codex', folderPresent: true, injected: true,
      approvalDetection: { source: 'config', mode, detail: '/home/test/.codex/config.toml' },
    }])
    await render(<HookHarness workspaceId="ws" />, install())
    expect(host.textContent).toContain(`Approvals: ${label}`)
    expect(host.textContent).not.toContain('/home/test/.codex/config.toml')
    expect(host.querySelector('[title="/home/test/.codex/config.toml"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Codex approval mode"]')).toBeNull()
    expect(host.querySelector('[aria-label="Codex integration"]')).not.toBeNull()
    expect(set).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('human permission-prompt notification')
  })

  it('refreshes detected configuration', async () => {
    inspectHooks.mockResolvedValue([])
    await render(<HookHarness workspaceId="ws" />, install())
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
