import { describe, it, expect, beforeEach } from 'vitest'
import {
  GLOBAL_MAX_WEBGL_TERMINALS,
  requestWebglGrant,
  releaseWebglGrant,
  reclaimWindowWebglGrants,
  liveWebglGrantCount,
} from './webglBudget'

// The broker holds module-level state; drain it between tests by reclaiming a
// generous range of window ids (tests only ever use ids 1..N).
beforeEach(() => {
  for (let id = 0; id <= 50; id++) reclaimWindowWebglGrants(id)
  expect(liveWebglGrantCount()).toBe(0)
})

describe('webglBudget — process-wide WebGL context budget', () => {
  it('grants up to the global cap, then denies — regardless of which window asks', () => {
    let granted = 0
    // Spread requests across three windows; the cap is process-wide, not per window.
    for (let i = 0; i < GLOBAL_MAX_WEBGL_TERMINALS + 5; i++) {
      const windowId = (i % 3) + 1
      if (requestWebglGrant(windowId, `panel-${i}`)) granted++
    }
    expect(granted).toBe(GLOBAL_MAX_WEBGL_TERMINALS)
    expect(liveWebglGrantCount()).toBe(GLOBAL_MAX_WEBGL_TERMINALS)
  })

  it('is idempotent per (window, panel): re-granting the same panel does not consume a second slot', () => {
    expect(requestWebglGrant(1, 'panel-a')).toBe(true)
    expect(requestWebglGrant(1, 'panel-a')).toBe(true)
    expect(requestWebglGrant(1, 'panel-a')).toBe(true)
    expect(liveWebglGrantCount()).toBe(1)
  })

  it('the same panelId in two different windows holds two independent slots', () => {
    expect(requestWebglGrant(1, 'shared-panel')).toBe(true)
    expect(requestWebglGrant(2, 'shared-panel')).toBe(true)
    expect(liveWebglGrantCount()).toBe(2)
  })

  it('releasing a slot frees capacity for the next requester', () => {
    for (let i = 0; i < GLOBAL_MAX_WEBGL_TERMINALS; i++) {
      expect(requestWebglGrant(1, `panel-${i}`)).toBe(true)
    }
    // At the cap: a new panel is denied.
    expect(requestWebglGrant(2, 'late')).toBe(false)
    // Free one slot; now the late panel gets in.
    releaseWebglGrant(1, 'panel-0')
    expect(requestWebglGrant(2, 'late')).toBe(true)
    expect(liveWebglGrantCount()).toBe(GLOBAL_MAX_WEBGL_TERMINALS)
  })

  it('releasing a slot a window does not hold is a no-op', () => {
    requestWebglGrant(1, 'panel-a')
    releaseWebglGrant(1, 'never-granted')
    releaseWebglGrant(99, 'panel-a')
    expect(liveWebglGrantCount()).toBe(1)
  })

  it('reclaims every grant a window held when it closes (crashed renderer never releases)', () => {
    requestWebglGrant(1, 'a')
    requestWebglGrant(1, 'b')
    requestWebglGrant(2, 'c')
    expect(liveWebglGrantCount()).toBe(3)

    reclaimWindowWebglGrants(1)
    expect(liveWebglGrantCount()).toBe(1) // only window 2's grant remains

    // The freed slots are usable again.
    for (let i = 0; i < GLOBAL_MAX_WEBGL_TERMINALS - 1; i++) {
      expect(requestWebglGrant(3, `panel-${i}`)).toBe(true)
    }
    expect(liveWebglGrantCount()).toBe(GLOBAL_MAX_WEBGL_TERMINALS)
  })
})
