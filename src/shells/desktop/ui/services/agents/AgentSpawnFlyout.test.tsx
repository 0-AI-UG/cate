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
