import { describe, expect, it } from 'vitest'
import { workspaceDisplayName } from './displayPath'

describe('workspaceDisplayName', () => {
  it('returns the folder name for a POSIX local path', () => {
    expect(workspaceDisplayName('/Users/anton/proj')).toBe('proj')
  })

  it('returns the folder name for a Windows local path', () => {
    expect(workspaceDisplayName('C:\\Users\\foo\\myproject')).toBe('myproject')
  })

  it('ignores a trailing separator on a Windows path', () => {
    expect(workspaceDisplayName('C:\\Users\\foo\\myproject\\')).toBe('myproject')
  })

  it('ignores a trailing separator on a POSIX path', () => {
    expect(workspaceDisplayName('/Users/anton/proj/')).toBe('proj')
  })

  it('returns the folder name for a remote POSIX locator', () => {
    expect(workspaceDisplayName('cate-companion://wsl_Ubuntu/home/foo/proj')).toBe('proj')
  })
})
