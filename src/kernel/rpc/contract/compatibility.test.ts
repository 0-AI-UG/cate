import { describe, expect, it } from 'vitest'
import { COMPATIBILITY_VERSION, isCompatible } from './compatibility'

describe('protocol compatibility', () => {
  it('requires the same explicit integer, with no release-version fallback', () => {
    expect(isCompatible(COMPATIBILITY_VERSION, COMPATIBILITY_VERSION)).toBe(true)
    for (const remote of [undefined, null, '2', 0, COMPATIBILITY_VERSION + 1, 1.5, NaN]) {
      expect(isCompatible(remote, COMPATIBILITY_VERSION)).toBe(false)
    }
  })
})
