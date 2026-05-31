import { describe, it, expect, beforeEach, vi } from 'vitest'

// cateControl / agentStore / settingsStore all import the renderer logger, which
// pulls in electron-log/renderer. That module hangs in the bare node test env, so
// stub it like the other renderer suites do (see agentStore.cateControl.test.ts).
vi.mock('../../renderer/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  registerCateContext,
  unregisterCateContext,
  dispatchCateRequest,
  __setExecutorsForTest,
} from './cateControl'
import { useAgentStore } from './agentStore'
import { useSettingsStore } from '../../renderer/stores/settingsStore'

function fakeCanvasStore() {
  return { getState: () => ({ nodes: {}, viewportOffset: { x: 0, y: 0 }, zoomLevel: 1 }) } as any
}

describe('dispatchCateRequest', () => {
  beforeEach(() => {
    useAgentStore.setState({ panels: {} })
    useSettingsStore.setState({ cateControlEnabled: true } as any)
    unregisterCateContext('k1')
    __setExecutorsForTest(null)
  })

  it('errors when the feature is globally disabled', async () => {
    useSettingsStore.setState({ cateControlEnabled: false } as any)
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    const res = await dispatchCateRequest('k1', { action: 'layout', params: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/disabled/i)
  })

  it('errors when no context is registered for the chat', async () => {
    const res = await dispatchCateRequest('unknown', { action: 'layout', params: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not registered|no context/i)
  })

  it('runs safe actions immediately without approval', async () => {
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    const exec = vi.fn().mockResolvedValue({ ok: true, result: { panels: [] } })
    __setExecutorsForTest({ layout: exec } as any)
    const res = await dispatchCateRequest('k1', { action: 'layout', params: {} })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: true, result: { panels: [] } })
  })

  it('auto mode runs side-effect actions without approval', async () => {
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    useAgentStore.getState().setCateControlMode('k1', 'auto')
    const exec = vi.fn().mockResolvedValue({ ok: true })
    __setExecutorsForTest({ panel: exec } as any)
    const res = await dispatchCateRequest('k1', { action: 'panel', params: { op: 'close', panelId: 'x' } })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(true)
  })

  it('guarded mode asks for approval and denies when the resolver says deny', async () => {
    const requestApproval = vi.fn().mockResolvedValue(false)
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore(), requestApproval })
    useAgentStore.getState().setCateControlMode('k1', 'guarded')
    const exec = vi.fn().mockResolvedValue({ ok: true })
    __setExecutorsForTest({ panel: exec } as any)
    const res = await dispatchCateRequest('k1', { action: 'panel', params: { op: 'close', panelId: 'x' } })
    expect(requestApproval).toHaveBeenCalledWith('panel', { op: 'close', panelId: 'x' })
    expect(exec).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: false, denied: true })
  })

  it('catches executor errors and returns them', async () => {
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    __setExecutorsForTest({ layout: vi.fn().mockRejectedValue(new Error('boom')) } as any)
    const res = await dispatchCateRequest('k1', { action: 'layout', params: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/boom/)
  })
})
