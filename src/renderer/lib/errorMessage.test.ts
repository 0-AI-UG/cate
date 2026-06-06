import { describe, it, expect } from 'vitest'
import { errorMessage } from './errorMessage'

describe('errorMessage', () => {
  it('strips the Electron IPC wrapper and maps the companion error', () => {
    const raw =
      `Error invoking remote method 'git:init': Error: No companion registered for id "srv_cd1df3a429"`
    expect(errorMessage(new Error(raw))).toBe(
      'The companion isn’t connected on this host yet. Install it and try again.',
    )
  })

  it('strips the IPC wrapper and leftover Error: prefix for unknown messages', () => {
    const raw = `Error invoking remote method 'git:status': Error: fatal: not a git repository`
    expect(errorMessage(new Error(raw))).toBe('fatal: not a git repository')
  })

  it('peels stacked Error: prefixes', () => {
    expect(errorMessage('Error: Error: boom')).toBe('boom')
  })

  it('maps filesystem and network errors', () => {
    expect(errorMessage(new Error('ENOENT: no such file or directory, open foo'))).toBe(
      'That file or folder no longer exists.',
    )
    expect(errorMessage(new Error('connect ECONNREFUSED 127.0.0.1:22'))).toBe(
      'Couldn’t reach the host. Check your connection and try again.',
    )
  })

  it('accepts strings, plain objects, and Error instances', () => {
    expect(errorMessage('plain string')).toBe('plain string')
    expect(errorMessage({ message: 'object message' })).toBe('object message')
    expect(errorMessage(new Error('real error'))).toBe('real error')
  })

  it('falls back when there is no usable message', () => {
    expect(errorMessage(null)).toBe('Something went wrong.')
    expect(errorMessage(undefined)).toBe('Something went wrong.')
    expect(errorMessage('', 'custom fallback')).toBe('custom fallback')
  })
})
