// Regression: detaching the workspace's primary canvas panel to another
// window used to wipe its children on the next autosave. The guard preserves
// the persisted snapshot when the live store is empty but the saved one had
// children.

import { describe, it, expect } from 'vitest'
import { shouldPreserveExistingCanvas } from './canvasSyncGuard'

describe('shouldPreserveExistingCanvas', () => {
  it('preserves persisted nodes when the live store is empty', () => {
    expect(shouldPreserveExistingCanvas(0, 3)).toBe(true)
  })

  it('lets a populated live store write through (normal case)', () => {
    expect(shouldPreserveExistingCanvas(5, 3)).toBe(false)
  })

  it('lets an empty live store overwrite an empty workspace (no data loss to prevent)', () => {
    expect(shouldPreserveExistingCanvas(0, 0)).toBe(false)
  })

  it('lets a populated live store overwrite an empty workspace (first save)', () => {
    expect(shouldPreserveExistingCanvas(2, 0)).toBe(false)
  })
})
