import { afterEach, expect, it, vi } from 'vitest'
import { revealPanel } from '@client/host'
import { INITIAL_UI_STATE, useUIStore } from '../state/uiStore'
import { openAgentSetupTerminal } from './agentSetupNavigation'

vi.mock('@client/host', () => ({ revealPanel: vi.fn() }))

afterEach(() => {
  useUIStore.setState(INITIAL_UI_STATE)
  vi.clearAllMocks()
})

it('reveals and focuses the native setup panel before dismissing Settings', async () => {
  useUIStore.setState({ overlay: { view: 'settings', section: 'agents' } })
  vi.mocked(revealPanel).mockImplementation(async () => {
    expect(useUIStore.getState().overlay?.view).toBe('settings')
    return true
  })
  expect(await openAgentSetupTerminal('remote-workspace', 'login-terminal')).toBe(true)
  expect(revealPanel).toHaveBeenCalledWith('remote-workspace', 'login-terminal', { retry: true })
  expect(useUIStore.getState().overlay).toBeNull()
})

it('keeps setup controls visible when the terminal has already closed', async () => {
  useUIStore.setState({ overlay: { view: 'settings', section: 'agents' } })
  vi.mocked(revealPanel).mockResolvedValue(false)
  expect(await openAgentSetupTerminal('remote-workspace', 'closed-terminal')).toBe(false)
  expect(useUIStore.getState().overlay?.view).toBe('settings')
})

it('does not dismiss a different overlay opened while navigating', async () => {
  useUIStore.setState({ overlay: { view: 'settings', section: 'agents' } })
  vi.mocked(revealPanel).mockImplementation(async () => {
    useUIStore.setState({ overlay: { view: 'usage' } })
    return true
  })
  await openAgentSetupTerminal('remote-workspace', 'login-terminal')
  expect(useUIStore.getState().overlay?.view).toBe('usage')
})
