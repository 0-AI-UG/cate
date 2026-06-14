// =============================================================================
// Tests for classifyExternalEvent — the pure routing decision for a filesystem
// event that lands on a file open in an EditorPanel.
// =============================================================================

import { describe, expect, it } from 'vitest'
import { classifyExternalEvent, shouldBlockOverwrite } from './externalConflict'

describe('classifyExternalEvent', () => {
  it('routes a delete to conflict-deleted regardless of dirty state', () => {
    expect(classifyExternalEvent('delete', false)).toBe('conflict-deleted')
    expect(classifyExternalEvent('delete', true)).toBe('conflict-deleted')
  })

  it('reloads a clean buffer on an external update or create', () => {
    expect(classifyExternalEvent('update', false)).toBe('reload')
    expect(classifyExternalEvent('create', false)).toBe('reload')
  })

  it('raises a changed-conflict when the buffer has unsaved edits', () => {
    expect(classifyExternalEvent('update', true)).toBe('conflict-changed')
    expect(classifyExternalEvent('create', true)).toBe('conflict-changed')
  })
})

describe('shouldBlockOverwrite', () => {
  it('blocks when disk diverged from the loaded baseline and differs from the buffer', () => {
    // baseline = what we loaded, disk = agent rewrote it, buffer = user edits
    expect(shouldBlockOverwrite('orig', 'agent-version', 'user-version')).toBe(true)
  })

  it('does not block when disk still matches the baseline (no external change)', () => {
    expect(shouldBlockOverwrite('orig', 'orig', 'user-version')).toBe(false)
  })

  it('does not block when the disk version already equals our buffer', () => {
    // e.g. the user/agent converged on the same content — nothing to lose
    expect(shouldBlockOverwrite('orig', 'same', 'same')).toBe(false)
  })

  it('does not block without a baseline (untitled / never loaded)', () => {
    expect(shouldBlockOverwrite(null, 'anything', 'buffer')).toBe(false)
  })

  it('does not block when the file is unreadable/deleted (disk read failed)', () => {
    expect(shouldBlockOverwrite('orig', null, 'buffer')).toBe(false)
  })
})
