// =============================================================================
// Tests for the pure notification gating predicate used by sendOsNotification.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { shouldSendNotification } from './notificationGating'

const enabled = { notificationsEnabled: true, notifyOnlyWhenUnfocused: false }
const enabledUnfocusedOnly = { notificationsEnabled: true, notifyOnlyWhenUnfocused: true }
const disabled = { notificationsEnabled: false, notifyOnlyWhenUnfocused: false }

describe('shouldSendNotification', () => {
  it('returns true when enabled and unfocused-only is off', () => {
    expect(shouldSendNotification(enabled, true)).toBe(true)
    expect(shouldSendNotification(enabled, false)).toBe(true)
  })

  it('returns false when the master switch is off', () => {
    expect(shouldSendNotification(disabled, false)).toBe(false)
    expect(shouldSendNotification(disabled, true)).toBe(false)
    // Even with notifyOnlyWhenUnfocused, master off wins.
    expect(
      shouldSendNotification({ notificationsEnabled: false, notifyOnlyWhenUnfocused: true }, false),
    ).toBe(false)
  })

  it('suppresses when notifyOnlyWhenUnfocused=true and the window is focused', () => {
    expect(shouldSendNotification(enabledUnfocusedOnly, true)).toBe(false)
  })

  it('fires when notifyOnlyWhenUnfocused=true and the window is NOT focused', () => {
    expect(shouldSendNotification(enabledUnfocusedOnly, false)).toBe(true)
  })
})
