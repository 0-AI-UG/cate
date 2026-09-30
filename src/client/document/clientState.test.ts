import { describe, expect, it, vi } from 'vitest'
import type { PresenceReport } from '@workspace/document/contract'
import { createClientStateStore } from './clientState'
import { reportPresence, setClientAttentive } from './presence'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('client state', () => {
  it('holds tabs, focus, selection, viewports and one-shot intents', () => {
    const state = createClientStateStore()
    const seen = vi.fn()
    state.subscribe(seen)
    state.setActiveTab('s1', 'p1')
    state.setActiveTab('s1', 'p1')
    state.focus('p1')
    state.focus('p1')
    state.setSelection('c1', ['n1'])
    state.setViewport('c1', { x: 1, y: 2, zoom: 1.5 })
    const id = state.pushIntent({ panelId: 'p1', kind: 'reveal', data: { line: 4 } })
    state.pushIntent({ panelId: 'p2', kind: 'reveal' })
    const snapshot = state.getSnapshot()
    expect(snapshot).toMatchObject({
      activeTabs: { s1: 'p1' },
      focusedPanelId: 'p1',
      focusEpoch: 2,
      selection: { c1: ['n1'] },
      viewports: { c1: { x: 1, y: 2, zoom: 1.5 } },
    })
    expect(state.takeIntents('p1')).toEqual([{ id, panelId: 'p1', kind: 'reveal', data: { line: 4 } }])
    expect(state.takeIntents('p1')).toEqual([])
    expect(state.getSnapshot().intents).toHaveLength(1)
    expect(seen).toHaveBeenCalledTimes(8)
  })
})

describe('presence reporting', () => {
  it('reports view and focus once per change, and again after a reconnect', async () => {
    const state = createClientStateStore()
    const reports: PresenceReport[] = []
    let ready: ((info: { reconnect: boolean }) => void) | null = null
    const stop = reportPresence(state, {
      report: async (r) => { reports.push(r) },
      onReady: (listener) => { ready = listener; return () => {} },
    })
    await tick()
    expect(reports).toEqual([{ viewing: [], focused: null, attentive: true }])

    state.setViewing(['p1', 'p2'])
    state.focus('p1')
    await tick()
    expect(reports.slice(1)).toEqual([{ viewing: ['p1', 'p2'], focused: 'p1', attentive: true }])

    state.setActiveTab('s1', 'p2')
    await tick()
    expect(reports).toHaveLength(2)

    setClientAttentive(false)
    await tick()
    expect(reports.slice(2)).toEqual([{ viewing: ['p1', 'p2'], focused: 'p1', attentive: false }])
    setClientAttentive(true)
    await tick()
    expect(reports).toHaveLength(4)

    ready!({ reconnect: true })
    await tick()
    expect(reports).toHaveLength(5)
    stop()
    state.focus('p2')
    await tick()
    expect(reports).toHaveLength(5)
  })
})
