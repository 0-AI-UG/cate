// =============================================================================
// Tests for threeWayMerge — line-based 3-way merge used by the editor's
// "Keep both" conflict resolution (baseline = common ancestor, mine = buffer,
// theirs = on-disk/agent version).
// =============================================================================

import { describe, expect, it } from 'vitest'
import { threeWayMerge } from './threeWayMerge'

describe('threeWayMerge', () => {
  it('returns the unchanged text when nothing diverged', () => {
    const r = threeWayMerge('a\nb\nc', 'a\nb\nc', 'a\nb\nc')
    expect(r.clean).toBe(true)
    expect(r.merged).toBe('a\nb\nc')
  })

  it('takes my side when only I changed it', () => {
    const r = threeWayMerge('a\nb\nc', 'a\nB\nc', 'a\nb\nc')
    expect(r.clean).toBe(true)
    expect(r.merged).toBe('a\nB\nc')
  })

  it('takes their side when only they changed it', () => {
    const r = threeWayMerge('a\nb\nc', 'a\nb\nc', 'a\nb\nC')
    expect(r.clean).toBe(true)
    expect(r.merged).toBe('a\nb\nC')
  })

  it('keeps both when the edits touch different lines', () => {
    // mine changes line 1, theirs changes line 3 — disjoint → clean merge
    const r = threeWayMerge('a\nb\nc', 'A\nb\nc', 'a\nb\nC')
    expect(r.clean).toBe(true)
    expect(r.merged).toBe('A\nb\nC')
  })

  it('keeps both for the real case: I edit line 1, the agent appends below', () => {
    const base = 'Hallo test. AAAAA'
    const mine = 'Hallo test. AAAAAaaaaaaa'
    const theirs = 'Hallo test. AAAAA\n\nThe Quiet Machine\na single test at last turns green.'
    const r = threeWayMerge(base, mine, theirs)
    expect(r.clean).toBe(true)
    expect(r.merged).toBe(
      'Hallo test. AAAAAaaaaaaa\n\nThe Quiet Machine\na single test at last turns green.',
    )
  })

  it('merges cleanly when both make the identical change', () => {
    const r = threeWayMerge('a\nb\nc', 'a\nX\nc', 'a\nX\nc')
    expect(r.clean).toBe(true)
    expect(r.merged).toBe('a\nX\nc')
  })

  it('emits conflict markers when both edit the same line differently', () => {
    const r = threeWayMerge('a\nb\nc', 'a\nMINE\nc', 'a\nTHEIRS\nc')
    expect(r.clean).toBe(false)
    expect(r.merged).toContain('<<<<<<<')
    expect(r.merged).toContain('MINE')
    expect(r.merged).toContain('=======')
    expect(r.merged).toContain('THEIRS')
    expect(r.merged).toContain('>>>>>>>')
    // unconflicted context is preserved around the markers
    expect(r.merged.startsWith('a\n')).toBe(true)
    expect(r.merged.endsWith('\nc')).toBe(true)
  })

  it('uses the provided side labels in conflict markers', () => {
    const r = threeWayMerge('b', 'MINE', 'THEIRS', { mine: 'Your edits', theirs: 'On disk' })
    expect(r.merged).toContain('<<<<<<< Your edits')
    expect(r.merged).toContain('>>>>>>> On disk')
  })

  it('preserves a trailing newline', () => {
    const r = threeWayMerge('a\nb\n', 'A\nb\n', 'a\nb\n')
    expect(r.merged).toBe('A\nb\n')
  })
})
