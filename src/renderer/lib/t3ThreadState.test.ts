import { describe, expect, it } from 'vitest'
import { t3ThreadActivity } from './t3ThreadState'

describe('T3 conversation state', () => {
  it('distinguishes waiting, active turns, background work, and completed conversations', () => {
    const thread = { id: 'a', title: 'A' }
    expect(t3ThreadActivity(thread)).toBe('notRunning')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'completed' } })).toBe('waitingForInput')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'running' } })).toBe('running')
    expect(t3ThreadActivity({ ...thread, backgroundLiveness: 'monitoring' })).toBe('running')
    expect(t3ThreadActivity({ ...thread, latestTurn: { state: 'running' }, hasPendingApprovals: true })).toBe('waitingForInput')
    expect(t3ThreadActivity({ ...thread, hasPendingUserInput: true })).toBe('waitingForInput')
  })

  it.each(['completed', 'interrupted', 'error'])('waits for input after a %s turn unless work continues', (state) => {
    const thread = { id: 'a', title: 'A', latestTurn: { state } }
    expect(t3ThreadActivity(thread)).toBe('waitingForInput')
    expect(t3ThreadActivity({ ...thread, backgroundLiveness: 'working' })).toBe('running')
    expect(t3ThreadActivity({ ...thread, session: { status: 'ready', activeTurnId: 'next' } })).toBe('running')
  })
})
