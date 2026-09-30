import { describe, expect, it } from 'vitest'
import {
  applyT3ShellEvent,
  canT3ThreadReceivePrompt,
  mergeT3ShellSnapshot,
  t3SnapshotBusy,
  t3ThreadActivity,
  type T3ShellSnapshot,
} from '../contract'

const empty: T3ShellSnapshot = { instanceId: 'i', checkout: '/repo', connected: false, sequence: 0, threads: {} }

describe('T3 thread state', () => {
  it('derives activity like a terminal agent', () => {
    expect(t3ThreadActivity({ id: 'a', title: '' })).toBe('notRunning')
    expect(t3ThreadActivity({ id: 'a', title: '', latestTurn: { state: 'running' } })).toBe('running')
    expect(t3ThreadActivity({ id: 'a', title: '', latestTurn: { state: 'completed' } })).toBe('waitingForInput')
    expect(t3ThreadActivity({ id: 'a', title: '', latestTurn: { state: 'running' }, hasPendingApprovals: true })).toBe('waitingForInput')
    expect(canT3ThreadReceivePrompt({ id: 'a', title: '', hasPendingUserInput: true })).toBe(false)
    expect(canT3ThreadReceivePrompt({ id: 'a', title: '', latestTurn: { state: 'completed' } })).toBe(true)
  })

  it('folds shell events into a snapshot', () => {
    let state = applyT3ShellEvent(empty, { kind: 'snapshot', snapshot: { snapshotSequence: 4, threads: [{ id: 'a', title: 'A', extra: 1 }, { id: 'b', title: 'B' }] } })
    state = applyT3ShellEvent(state, { kind: 'thread-upserted', sequence: 5, thread: { id: 'b', title: 'Renamed', latestTurn: { state: 'running' } } })
    state = applyT3ShellEvent(state, { kind: 'thread-removed', sequence: 6, threadId: 'a' })
    expect(state).toMatchObject({ connected: true, sequence: 6, threads: { b: { title: 'Renamed' } } })
    expect(Object.keys(state.threads)).toEqual(['b'])
    expect(t3SnapshotBusy(state)).toBe(true)
    expect(t3SnapshotBusy({ ...state, connected: false })).toBe(false)
  })

  it('keeps unchanged threads stable and ignores older snapshots', () => {
    const first: T3ShellSnapshot = { ...empty, connected: true, sequence: 2, threads: { a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'B' } } }
    const next = mergeT3ShellSnapshot(first, { ...first, sequence: 3, threads: { a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'B2' } } })
    expect(next.threads.a).toBe(first.threads.a)
    expect(next.threads.b.title).toBe('B2')
    expect(mergeT3ShellSnapshot(next, { ...first, sequence: 1 })).toBe(next)
    expect(mergeT3ShellSnapshot(next, { ...next, threads: { ...next.threads } })).toBe(next)
  })
})
