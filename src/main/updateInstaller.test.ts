import { describe, it, expect, vi, beforeEach } from 'vitest'

const isInApplicationsFolder = vi.fn()
vi.mock('electron', () => ({
  app: {
    isInApplicationsFolder: () => isInApplicationsFolder(),
  },
}))

import { canSelfUpdate } from './updateInstaller'

describe('canSelfUpdate', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('returns true on non-darwin regardless of folder', () => {
    expect(canSelfUpdate('win32')).toBe(true)
    expect(canSelfUpdate('linux')).toBe(true)
  })

  it('returns true on darwin only when in /Applications (not translocated)', () => {
    isInApplicationsFolder.mockReturnValue(true)
    expect(canSelfUpdate('darwin')).toBe(true)
  })

  it('returns false on darwin when translocated / not in /Applications', () => {
    isInApplicationsFolder.mockReturnValue(false)
    expect(canSelfUpdate('darwin')).toBe(false)
  })

  it('returns true on darwin if the API throws (do not block the existing path)', () => {
    isInApplicationsFolder.mockImplementation(() => { throw new Error('unavailable') })
    expect(canSelfUpdate('darwin')).toBe(true)
  })
})
