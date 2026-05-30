import { describe, it, expect, beforeEach, vi } from 'vitest'

// agentStore imports the renderer logger, which pulls in electron-log/renderer.
// That module hangs in the bare node test env, so stub it like the other
// renderer suites do (see WorkspaceTab.test.tsx / terminalRegistry.test.ts).
vi.mock('../../renderer/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { useAgentStore } from './agentStore'

describe('agentStore cateControlMode', () => {
  beforeEach(() => {
    useAgentStore.setState({ panels: {} })
  })

  it('defaults to guarded when read for an unknown panel', () => {
    expect(useAgentStore.getState().getCateControlMode('k1')).toBe('guarded')
  })

  it('setCateControlMode creates the panel slice and stores the mode', () => {
    useAgentStore.getState().setCateControlMode('k1', 'auto')
    expect(useAgentStore.getState().getCateControlMode('k1')).toBe('auto')
  })

  it('toggles back to guarded', () => {
    useAgentStore.getState().setCateControlMode('k1', 'auto')
    useAgentStore.getState().setCateControlMode('k1', 'guarded')
    expect(useAgentStore.getState().getCateControlMode('k1')).toBe('guarded')
  })
})
