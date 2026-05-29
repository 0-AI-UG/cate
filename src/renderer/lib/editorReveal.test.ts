import { describe, it, expect } from 'vitest'

import { setPendingReveal, takePendingReveal } from './editorReveal'

describe('editorReveal — one-shot pending reveal registry', () => {
  it('returns a reveal that was set for a panel', () => {
    setPendingReveal('panel-a', { line: 12, column: 5 })
    expect(takePendingReveal('panel-a')).toEqual({ line: 12, column: 5 })
  })

  it('is one-shot — a second take returns undefined', () => {
    setPendingReveal('panel-b', { line: 3 })
    takePendingReveal('panel-b')
    expect(takePendingReveal('panel-b')).toBeUndefined()
  })

  it('returns undefined for a panel with no pending reveal', () => {
    expect(takePendingReveal('never-set')).toBeUndefined()
  })

  it('keeps reveals separate per panel', () => {
    setPendingReveal('p1', { line: 1 })
    setPendingReveal('p2', { line: 2 })
    expect(takePendingReveal('p2')).toEqual({ line: 2 })
    expect(takePendingReveal('p1')).toEqual({ line: 1 })
  })
})
