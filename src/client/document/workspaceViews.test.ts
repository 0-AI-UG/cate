import { describe, expect, it, vi } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { createClientStateStore } from './clientState'
import { loadWorkspaceViews, WORKSPACE_VIEWS_DOCUMENT } from './workspaceViews'

describe('remembered workspace views', () => {
  it('restores separate workspaces and canvases across client restarts', async () => {
    const device = createMemoryDeviceStore()
    const views = await loadWorkspaceViews(device)
    const first = createClientStateStore()
    const second = createClientStateStore()
    const stopFirst = views.remember('one', first)
    const stopSecond = views.remember('two', second)
    first.setViewport('canvas', { x: -321, y: 45, zoom: 0.7 })
    first.setViewport('other', { x: 11, y: 22, zoom: 2 })
    second.setViewport('canvas', { x: 123, y: -456, zoom: 1.5 })
    first.focus('temporary-focus')
    stopFirst()
    stopSecond()
    views.dispose()
    const restarted = await loadWorkspaceViews(device)
    expect(createClientStateStore(restarted.viewports('one')).getSnapshot()).toMatchObject({
      focusedPanelId: null,
      viewports: { canvas: { x: -321, y: 45, zoom: 0.7 }, other: { x: 11, y: 22, zoom: 2 } },
    })
    expect(restarted.viewports('two')).toEqual({ canvas: { x: 123, y: -456, zoom: 1.5 } })
    expect(restarted.viewports('new')).toEqual({})
    restarted.dispose()
  })

  it('ignores invalid persisted cameras', async () => {
    const device = createMemoryDeviceStore({ [WORKSPACE_VIEWS_DOCUMENT]: {
      ws: { valid: { x: 10, y: 20, zoom: 1 }, negative: { x: 0, y: 0, zoom: -1 }, missing: {}, text: 'bad', nil: null },
      invalid: null,
    } })
    const views = await loadWorkspaceViews(device)
    expect(views.viewports('ws')).toEqual({ valid: { x: 10, y: 20, zoom: 1 } })
    expect(views.viewports('invalid')).toEqual({})
    views.dispose()
  })

  it.each([undefined, null, [], 'invalid', 42])('starts empty for a malformed or missing document: %s', async (raw) => {
    const device = createMemoryDeviceStore({ [WORKSPACE_VIEWS_DOCUMENT]: raw })
    const views = await loadWorkspaceViews(device)
    expect(views.viewports('ws')).toEqual({})
    views.dispose()
  })

  it('can save a new camera after the initial device read fails', async () => {
    const device = createMemoryDeviceStore()
    vi.spyOn(device, 'get').mockRejectedValueOnce(new Error('read failed'))
    const views = await loadWorkspaceViews(device)
    const state = createClientStateStore(views.viewports('ws'))
    const stop = views.remember('ws', state)
    state.setViewport('c', { x: -10, y: 20, zoom: 0.5 })
    expect(await device.get(WORKSPACE_VIEWS_DOCUMENT)).toEqual({ ws: { c: { x: -10, y: 20, zoom: 0.5 } } })
    stop()
    views.dispose()
  })

  it('preserves cameras saved elsewhere without moving the active camera', async () => {
    const device = createMemoryDeviceStore()
    const views = await loadWorkspaceViews(device)
    const state = createClientStateStore(views.viewports('ws'))
    const stop = views.remember('ws', state)
    device.change(WORKSPACE_VIEWS_DOCUMENT, { ws: { other: { x: 1, y: 2, zoom: 3 } } })
    expect(state.getSnapshot().viewports).toEqual({})
    state.setViewport('active', { x: 4, y: 5, zoom: 1 })
    expect(await device.get(WORKSPACE_VIEWS_DOCUMENT)).toEqual({ ws: {
      other: { x: 1, y: 2, zoom: 3 }, active: { x: 4, y: 5, zoom: 1 },
    } })
    stop()
    views.dispose()
  })

  it('does not write focus changes and stops persisting on detach', async () => {
    const device = createMemoryDeviceStore()
    const write = vi.spyOn(device, 'set')
    const views = await loadWorkspaceViews(device)
    const state = createClientStateStore()
    const stop = views.remember('ws', state)
    state.focus('panel')
    expect(write).not.toHaveBeenCalled()
    state.setViewport('c', { x: 1, y: 2, zoom: 1 })
    expect(write).toHaveBeenCalledTimes(1)
    stop()
    state.setViewport('c', { x: 3, y: 4, zoom: 1 })
    expect(write).toHaveBeenCalledTimes(1)
    views.dispose()
  })
})
