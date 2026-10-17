// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { UI_STATE_DOCUMENT, createUiStateStore, installUiState } from '../../app/state/uiState'
import { canvasKey, skillAgentKey, skillsKey, toggleCollapsed, useTreeCollapseStore } from './treeCollapse'

describe('treeCollapse', () => {
  let device: ReturnType<typeof createMemoryDeviceStore>

  beforeEach(async () => {
    device = createMemoryDeviceStore()
    const store = createUiStateStore(device)
    await store.load()
    installUiState(store)
  })

  afterEach(() => installUiState(null))

  it('keys are workspace-scoped', () => {
    expect(canvasKey('w1', 'c1')).not.toBe(canvasKey('w2', 'c1'))
    expect(skillAgentKey('w1', 'claude-code')).not.toBe(skillAgentKey('w2', 'claude-code'))
    expect(skillsKey('w1')).toBe('w1:skills')
  })

  it('defaults to expanded and toggles both ways', () => {
    const key = skillAgentKey('w1', 'claude-code')
    expect(useTreeCollapseStore.getState().collapsed.has(key)).toBe(false)
    toggleCollapsed(key)
    expect(useTreeCollapseStore.getState().collapsed.has(key)).toBe(true)
    toggleCollapsed(key)
    expect(useTreeCollapseStore.getState().collapsed.has(key)).toBe(false)
  })

  it('writes collapsed keys to the device ui-state so they survive a restart', async () => {
    toggleCollapsed(skillsKey('w1'))
    await Promise.resolve()
    expect(await device.get(UI_STATE_DOCUMENT)).toMatchObject({ sidebarTreeCollapsed: ['w1:skills'] })
    toggleCollapsed(skillsKey('w1'))
    await Promise.resolve()
    expect(await device.get(UI_STATE_DOCUMENT)).toMatchObject({ sidebarTreeCollapsed: [] })
  })

  it('follows an external edit of ui-state', () => {
    device.change(UI_STATE_DOCUMENT, { sidebarTreeCollapsed: ['w1:skills'] })
    expect(useTreeCollapseStore.getState().collapsed.has('w1:skills')).toBe(true)
  })
})
