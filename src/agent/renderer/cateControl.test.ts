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
import { useSettingsStore } from '../../renderer/stores/settingsStore'

function fakeCanvasStore() {
  return { getState: () => ({ nodes: {}, viewportOffset: { x: 0, y: 0 }, zoomLevel: 1 }) } as any
}

describe('dispatchCateRequest', () => {
  beforeEach(() => {
    useSettingsStore.setState({ cateControlEnabled: true } as any)
    unregisterCateContext('k1')
    __setExecutorsForTest(null)
  })

  it('errors when the feature is disabled', async () => {
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

  it('runs the executor for the action when enabled (no approval gate)', async () => {
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    const exec = vi.fn().mockResolvedValue({ ok: true, result: { panels: [] } })
    __setExecutorsForTest({ layout: exec } as any)
    const res = await dispatchCateRequest('k1', { action: 'layout', params: {} })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ ok: true, result: { panels: [] } })
  })

  it('runs side-effect actions immediately (no guard)', async () => {
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    const exec = vi.fn().mockResolvedValue({ ok: true })
    __setExecutorsForTest({ panel: exec } as any)
    const res = await dispatchCateRequest('k1', { action: 'panel', params: { op: 'close', panel: 'x' } })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(res.ok).toBe(true)
  })

  it('errors for an unknown action', async () => {
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    __setExecutorsForTest({} as any)
    const res = await dispatchCateRequest('k1', { action: 'nope' as any, params: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown or unimplemented/i)
  })

  it('catches executor errors and returns them', async () => {
    registerCateContext('k1', { workspaceId: 'w1', hostPanelId: 'p1', canvasStore: fakeCanvasStore() })
    __setExecutorsForTest({ layout: vi.fn().mockRejectedValue(new Error('boom')) } as any)
    const res = await dispatchCateRequest('k1', { action: 'layout', params: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/boom/)
  })
})
