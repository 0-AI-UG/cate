import { describe, it, expect } from 'vitest'
import { compareSemver, isPrereleaseVersion } from './semver'

describe('compareSemver', () => {
  it('orders release versions by core', () => {
    expect(compareSemver('1.2.1', '1.2.0')).toBe(1)
    expect(compareSemver('1.2.0', '1.2.1')).toBe(-1)
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1)
    expect(compareSemver('1.2.0', '1.2.0')).toBe(0)
  })

  it('tolerates a leading v', () => {
    expect(compareSemver('v1.3.0', '1.2.0')).toBe(1)
    expect(compareSemver('v1.2.0', 'v1.2.0')).toBe(0)
  })

  it('ranks a pre-release below its own release', () => {
    expect(compareSemver('1.2.0-beta.1', '1.2.0')).toBe(-1)
    expect(compareSemver('1.2.0', '1.2.0-beta.1')).toBe(1)
  })

  it('lets a stable release outrank an earlier beta (roll-forward)', () => {
    // A tester on 1.2.0-beta.3 should be offered stable 1.2.0.
    expect(compareSemver('1.2.0', '1.2.0-beta.3')).toBe(1)
  })

  it('orders pre-releases of the same core numerically', () => {
    expect(compareSemver('1.2.0-beta.2', '1.2.0-beta.1')).toBe(1)
    expect(compareSemver('1.2.0-beta.10', '1.2.0-beta.2')).toBe(1)
    expect(compareSemver('1.2.0-beta.1', '1.2.0-beta.1')).toBe(0)
  })

  it('full beta channel ordering sorts as expected', () => {
    const versions = ['1.2.0', '1.2.0-beta.1', '1.2.1', '1.2.0-beta.10', '1.2.0-beta.2']
    const sorted = [...versions].sort(compareSemver)
    expect(sorted).toEqual(['1.2.0-beta.1', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0', '1.2.1'])
  })
})

describe('isPrereleaseVersion', () => {
  it('detects a pre-release suffix', () => {
    expect(isPrereleaseVersion('1.2.0-beta.1')).toBe(true)
    expect(isPrereleaseVersion('1.2.0-rc.1')).toBe(true)
    expect(isPrereleaseVersion('1.2.0')).toBe(false)
  })
})
