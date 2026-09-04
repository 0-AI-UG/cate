import { describe, expect, it } from 'vitest'
import { assertLinuxGlibcBaseline, requiredGlibcVersions } from './linux-node-pty.mjs'

describe('Linux node-pty glibc baseline', () => {
  it('accepts a binary at the supported baseline', () => {
    const versionInfo = 'Name: GLIBC_2.2.5\nName: GLIBC_2.28\nName: GLIBC_2.14'
    expect(requiredGlibcVersions(versionInfo)).toEqual(['2.2.5', '2.14', '2.28'])
    expect(assertLinuxGlibcBaseline(versionInfo)).toBe('2.28')
  })

  it('rejects the GLIBC_2.34 regression from issue #604', () => {
    const versionInfo = 'Name: GLIBC_2.28\nName: GLIBC_2.32\nName: GLIBC_2.34'
    expect(() => assertLinuxGlibcBaseline(versionInfo)).toThrow(
      'pty.node requires GLIBC_2.34, newer than the supported GLIBC_2.28 baseline',
    )
  })
})
