import { describe, expect, it } from 'vitest'
import {
  canT3ThreadReceivePrompt,
  t3ThreadActivity,
} from '../contract'

describe('T3 thread state', () => {
  it('derives activity like a terminal agent', () => {
    expect(t3ThreadActivity({ id: 'a', title: '' })).toBe('notRunning')
    expect(t3ThreadActivity({ id: 'a', title: '', latestTurn: { state: 'running' } })).toBe('running')
    expect(t3ThreadActivity({ id: 'a', title: '', latestTurn: { state: 'completed' } })).toBe('waitingForInput')
    expect(t3ThreadActivity({ id: 'a', title: '', latestTurn: { state: 'running' }, hasPendingApprovals: true })).toBe('waitingForInput')
    expect(canT3ThreadReceivePrompt({ id: 'a', title: '', hasPendingUserInput: true })).toBe(false)
    expect(canT3ThreadReceivePrompt({ id: 'a', title: '', latestTurn: { state: 'completed' } })).toBe(true)
  })
})
