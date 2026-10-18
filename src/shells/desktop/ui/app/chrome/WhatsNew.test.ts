import { describe, expect, it } from 'vitest'
import { whatsNewOnLaunch } from './WhatsNew'

describe('whatsNewOnLaunch', () => {
  const launch = (over: Partial<Parameters<typeof whatsNewOnLaunch>[0]>) =>
    whatsNewOnLaunch({ version: '2.1.0', seen: '2.0.5', onboardingCompleted: true, hasNotes: true, ...over })

  it('shows once for a new version', () => {
    expect(launch({})).toBe('show')
    expect(launch({ seen: '2.1.0' })).toBe('none')
  })

  it('shows to someone who used Cate before it remembered a version', () => {
    expect(launch({ seen: '' })).toBe('show')
  })

  it('only notes the version on a first install: the tour is its welcome', () => {
    expect(launch({ seen: '', onboardingCompleted: false })).toBe('record')
  })

  it('waits for a replayed tour, and stays shut without notes for the version', () => {
    expect(launch({ onboardingCompleted: false })).toBe('none')
    expect(launch({ hasNotes: false })).toBe('none')
  })
})
