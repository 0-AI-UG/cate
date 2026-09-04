import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPanelInteraction,
  clearPanelInteractions,
  usePanelInteractionStore,
} from './panelInteractions'

describe('panelInteractions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearPanelInteractions()
  })

  afterEach(() => {
    clearPanelInteractions()
    vi.useRealTimers()
  })

  it('tracks a resolved operation without retaining request contents', () => {
    const finish = beginPanelInteraction({
      workspaceId: 'ws',
      sourcePanelId: 'agent',
      targetPanelId: 'browser',
      kind: 'control',
    })

    expect(Object.values(usePanelInteractionStore.getState().interactions)).toEqual([
      expect.objectContaining({
        workspaceId: 'ws',
        sourcePanelId: 'agent',
        targetPanelId: 'browser',
        kind: 'control',
        phase: 'active',
        activeCount: 1,
      }),
    ])

    finish(true)
    expect(Object.values(usePanelInteractionStore.getState().interactions)[0]?.phase).toBe('active')
    vi.advanceTimersByTime(4_999)
    expect(Object.values(usePanelInteractionStore.getState().interactions)[0]?.phase).toBe('active')
    vi.advanceTimersByTime(1)
    expect(Object.values(usePanelInteractionStore.getState().interactions)[0]?.phase).toBe('succeeded')
    vi.advanceTimersByTime(39_999)
    expect(Object.values(usePanelInteractionStore.getState().interactions)[0]?.phase).toBe('succeeded')
    vi.advanceTimersByTime(1)
    expect(usePanelInteractionStore.getState().interactions).toEqual({})
  })

  it('coalesces concurrent calls for the same directed pair', () => {
    const input = {
      workspaceId: 'ws',
      sourcePanelId: 'terminal-a',
      targetPanelId: 'terminal-b',
      kind: 'control' as const,
    }
    const finishFirst = beginPanelInteraction(input)
    const finishSecond = beginPanelInteraction(input)
    const interaction = () => Object.values(usePanelInteractionStore.getState().interactions)[0]

    expect(interaction()?.activeCount).toBe(2)
    finishFirst(false)
    expect(interaction()).toMatchObject({ activeCount: 1, phase: 'active' })
    finishSecond(true)
    expect(interaction()).toMatchObject({ activeCount: 0, phase: 'active' })
    vi.advanceTimersByTime(5_000)
    expect(interaction()).toMatchObject({ activeCount: 0, phase: 'succeeded' })
  })

  it('extends one continuous active state when quick calls repeat', () => {
    const input = {
      workspaceId: 'ws',
      sourcePanelId: 'agent',
      targetPanelId: 'browser',
      kind: 'control' as const,
    }
    const interaction = () => Object.values(usePanelInteractionStore.getState().interactions)[0]

    beginPanelInteraction(input)(true)
    vi.advanceTimersByTime(2_000)
    beginPanelInteraction(input)(true)
    vi.advanceTimersByTime(4_999)
    expect(interaction()?.phase).toBe('active')

    vi.advanceTimersByTime(1)
    expect(interaction()?.phase).toBe('succeeded')
  })

  it('ignores self-interactions and stale completion callbacks', () => {
    const finish = beginPanelInteraction({
      workspaceId: 'ws',
      sourcePanelId: 'same',
      targetPanelId: 'same',
      kind: 'read',
    })
    finish(false)
    finish(true)
    expect(usePanelInteractionStore.getState().interactions).toEqual({})
  })

})
