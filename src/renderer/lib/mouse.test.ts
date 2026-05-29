import { describe, it, expect } from 'vitest'

import { isMiddleClick } from './mouse'

describe('isMiddleClick', () => {
  it('is true for the middle button (button 1)', () => {
    expect(isMiddleClick({ button: 1 })).toBe(true)
  })

  it('is false for the left button (button 0)', () => {
    expect(isMiddleClick({ button: 0 })).toBe(false)
  })

  it('is false for the right button (button 2)', () => {
    // auxclick fires for BOTH middle and right — right-click must keep opening
    // the context menu, not close the tab.
    expect(isMiddleClick({ button: 2 })).toBe(false)
  })
})
