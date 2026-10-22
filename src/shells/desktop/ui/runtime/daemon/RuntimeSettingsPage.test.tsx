;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ info: vi.fn() }))
const runtime = vi.hoisted(() => ({ runtime: { info: h.info } }))
vi.mock('../../kernel/rpc', () => ({ useRuntime: () => runtime }))
vi.mock('../../kernel/settings', () => ({
  useWorkspaceSettings: () => ({ runtimeNetwork: 'off', runtimeLifetime: 'stopWhenIdle' }),
  setWorkspaceSetting: vi.fn(),
}))

import { RuntimeSettingsPage } from './RuntimeSettingsPage'

it('replaces the spinner with the error and a retry when the runtime does not answer', async () => {
  h.info.mockRejectedValueOnce(new Error('runtime unreachable'))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<RuntimeSettingsPage workspaceId="ws" />))
    expect(host.querySelector('.animate-spin')).toBeNull()
    expect(host.textContent).toContain('runtime unreachable')
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!

    h.info.mockResolvedValueOnce({ version: '9.9.9', protocol: [1, 2], clients: [] })
    await act(async () => retry.click())
    expect(h.info).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('9.9.9 (protocol 1.2), 0 connected clients')
    expect(host.textContent).not.toContain('Retry')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
