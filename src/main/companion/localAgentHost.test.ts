import { describe, it, expect } from 'vitest'
import { findNodeBinaryOnPath } from './localAgentHost'

describe('findNodeBinaryOnPath', () => {
  it('finds the first node.exe across a Windows PATH', () => {
    const path = 'C:\\Windows;C:\\Program Files\\nodejs;C:\\other'
    const present = new Set(['C:\\Program Files\\nodejs\\node.exe'])
    expect(findNodeBinaryOnPath(path, 'win32', (p) => present.has(p)))
      .toBe('C:\\Program Files\\nodejs\\node.exe')
  })

  it('returns null on Windows when only node.cmd exists (CreateProcess ignores it)', () => {
    const path = 'C:\\nvm'
    const present = new Set(['C:\\nvm\\node.cmd'])
    expect(findNodeBinaryOnPath(path, 'win32', (p) => present.has(p))).toBeNull()
  })

  it('honours an existing trailing separator in a PATH entry', () => {
    const present = new Set(['C:\\nodejs\\node.exe'])
    expect(findNodeBinaryOnPath('C:\\nodejs\\', 'win32', (p) => present.has(p)))
      .toBe('C:\\nodejs\\node.exe')
  })

  it('looks for bare `node` with `:` separators off-Windows', () => {
    const path = '/usr/bin:/opt/homebrew/bin:/sbin'
    const present = new Set(['/opt/homebrew/bin/node'])
    expect(findNodeBinaryOnPath(path, 'darwin', (p) => present.has(p)))
      .toBe('/opt/homebrew/bin/node')
  })

  it('returns null when no node is on PATH or PATH is empty', () => {
    expect(findNodeBinaryOnPath('/usr/bin:/sbin', 'linux', () => false)).toBeNull()
    expect(findNodeBinaryOnPath('', 'linux', () => true)).toBeNull()
  })
})
