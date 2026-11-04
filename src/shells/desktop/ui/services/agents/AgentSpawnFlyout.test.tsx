import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { installClientUi } from '@kernel/interaction'
import { setRuntimeResolver } from '@kernel/rpc/client'
import type { ChannelEvent } from '@kernel/rpc/contract'
import type { AgentAvailability, AgentTypeInfo } from '@services/agents/contract'
import { fakeStream } from '@services/agents/client/testing'
import { AgentSpawnFlyout } from './AgentSpawnFlyout'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('offers setup from the launcher when no agent is ready', async () => {
  const openSettings = vi.fn()
  installClientUi({ openSettings } as never)
  const stream = fakeStream<ChannelEvent<AgentAvailability, AgentAvailability>>()
  const runtime = { agents: { availability: () => stream.sub } }
  const stop = setRuntimeResolver((id) => id === 'no-agents' ? runtime as never : null)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onShown = vi.fn()
  try {
    await act(async () => { root.render(<AgentSpawnFlyout workspaceId="no-agents" side="up" onPick={() => {}} onShown={onShown} />) })
    expect(onShown).toHaveBeenCalledWith(true)
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Set up AI agents"]')!.click())
    expect(openSettings).toHaveBeenCalledWith('agents')
    expect(host.querySelector('[aria-label="API provider"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
    stop()
  }
})

it('shows the configured connection and selected model in the compact launch label', async () => {
  const stream = fakeStream<ChannelEvent<AgentAvailability, AgentAvailability>>()
  const types: AgentTypeInfo[] = [{ agentId: 'opencode', displayName: 'OpenCode', ready: true, connection: 'api', model: 'deepseek-chat' }, { agentId: 'codex', displayName: 'Codex', ready: true, connection: 'native' }]
  const runtime = { agents: { availability: () => stream.sub } }
  const stop = setRuntimeResolver((id) => id === 'connection-labels' ? runtime as never : null)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onPick = vi.fn()
  try {
    await act(async () => { root.render(<AgentSpawnFlyout workspaceId="connection-labels" side="up" onPick={onPick} onShown={() => {}} />) })
    act(() => stream.emit({ kind: 'snapshot', rev: 0, snapshot: { snapshot: { host: { name: 'host', platform: 'darwin', arch: 'arm64' }, agents: [], providers: [] }, types, refreshing: false, error: null } }))
    const paid = host.querySelector<HTMLButtonElement>('[aria-label="New OpenCode · API provider · deepseek-chat"]')!
    expect(paid).not.toBeNull()
    expect(host.querySelector('[aria-label="New Codex · Native account"]')).not.toBeNull()
    act(() => paid.click())
    expect(onPick).toHaveBeenCalledWith('opencode')
    act(() => stream.emit({ kind: 'change', rev: 1, change: { snapshot: { host: { name: 'host', platform: 'darwin', arch: 'arm64' }, agents: [], providers: [] }, types: types.filter((type) => type.agentId === 'codex'), refreshing: false, error: null } }))
    expect(host.querySelector('[aria-label="New OpenCode · API provider · deepseek-chat"]')).toBeNull()
    expect(host.querySelector('[aria-label="New Codex · Native account"]')).not.toBeNull()
  } finally {
    act(() => root.unmount())
    host.remove()
    stop()
  }
})
