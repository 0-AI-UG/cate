// =============================================================================
// activeSurface — placement routing for keyboard-created panels.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest'
import {
  setActiveSurface,
  getActiveSurface,
  clearActiveDockStack,
  placementForActiveSurface,
} from './activeSurface'

beforeEach(() => {
  // Reset to a known state. There's no public reset, so re-point at a canvas
  // (which placementForActiveSurface treats as "default" / undefined).
  setActiveSurface({ kind: 'canvas', canvasPanelId: 'reset' })
})

describe('placementForActiveSurface', () => {
  it('targets the exact stack when a dock stack is active (handles splits)', () => {
    setActiveSurface({ kind: 'dock', zone: 'center', stackId: 'stack-right' })
    expect(placementForActiveSurface()).toEqual({ target: 'dock', zone: 'center', stackId: 'stack-right' })
  })

  it('returns undefined (default canvas placement) when a canvas is active', () => {
    setActiveSurface({ kind: 'canvas', canvasPanelId: 'c1' })
    expect(placementForActiveSurface()).toBeUndefined()
  })

  it('keeps the dock target after the click — no DOM focus required', () => {
    // The whole point: clicking a tab marks the stack active and it STAYS active,
    // so a later shortcut routes there even though nothing holds DOM focus.
    setActiveSurface({ kind: 'dock', zone: 'bottom', stackId: 'stack-b' })
    expect(placementForActiveSurface()).toEqual({ target: 'dock', zone: 'bottom', stackId: 'stack-b' })
  })
})

describe('clearActiveDockStack', () => {
  it('forgets the active dock stack when that stack is removed', () => {
    setActiveSurface({ kind: 'dock', zone: 'left', stackId: 'gone' })
    clearActiveDockStack('gone')
    expect(getActiveSurface()).toBeNull()
    expect(placementForActiveSurface()).toBeUndefined()
  })

  it('leaves a different active stack untouched', () => {
    setActiveSurface({ kind: 'dock', zone: 'left', stackId: 'keep' })
    clearActiveDockStack('other')
    expect(getActiveSurface()).toEqual({ kind: 'dock', zone: 'left', stackId: 'keep' })
  })

  it('does not touch an active canvas', () => {
    setActiveSurface({ kind: 'canvas', canvasPanelId: 'c1' })
    clearActiveDockStack('anything')
    expect(getActiveSurface()).toEqual({ kind: 'canvas', canvasPanelId: 'c1' })
  })
})
