import { describe, expect, it } from 'vitest'
import { shouldShowNotification } from './gating'

const always = { notificationsEnabled: true, notifyOnlyWhenUnfocused: false }
const unfocusedOnly = { notificationsEnabled: true, notifyOnlyWhenUnfocused: true }

describe('shouldShowNotification', () => {
  it('shows regardless of focus when unfocused-only is off', () => {
    expect(shouldShowNotification(always, true)).toBe(true)
    expect(shouldShowNotification(always, false)).toBe(true)
  })

  it('never shows when notifications are off', () => {
    expect(shouldShowNotification({ notificationsEnabled: false, notifyOnlyWhenUnfocused: false }, false)).toBe(false)
    expect(shouldShowNotification({ notificationsEnabled: false, notifyOnlyWhenUnfocused: true }, false)).toBe(false)
  })

  it('shows only while unfocused when unfocused-only is on', () => {
    expect(shouldShowNotification(unfocusedOnly, true)).toBe(false)
    expect(shouldShowNotification(unfocusedOnly, false)).toBe(true)
  })
})
