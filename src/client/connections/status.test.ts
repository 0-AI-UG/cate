import { describe, expect, it } from 'vitest'
import { connectionLabel, connectionRemedy, relativeTime } from './status'

describe('connection labels', () => {
  it('describe offline with the last-seen time', () => {
    const now = 10 * 60_000
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(connectionLabel({ kind: 'offline', lastSeen: now - 2 * 3_600_000, retrying: true }, now)).toBe('Offline, last seen 2 hours ago. Retrying.')
    expect(connectionLabel({ kind: 'offline', lastSeen: null, retrying: false, error: 'ECONNREFUSED' })).toBe('Not reachable: ECONNREFUSED')
  })

  it('name an incompatible runtime and stay quiet when connected', () => {
    expect(connectionLabel({ kind: 'incompatible', runtimeVersion: '1.9.0' })).toContain('1.9.0')
    expect(connectionLabel({ kind: 'connected' })).toBeNull()
  })

  it('offer a remedy for an incompatible, offline or stopped runtime only', () => {
    expect(connectionRemedy({ kind: 'incompatible', runtimeVersion: '1.9.0' })).toBe('resolve')
    expect(connectionRemedy({ kind: 'offline', lastSeen: null, retrying: false })).toBe('retry')
    expect(connectionRemedy({ kind: 'stopped' })).toBe('start')
    expect(connectionRemedy({ kind: 'refused', message: 'no' })).toBeNull()
    expect(connectionRemedy({ kind: 'connected' })).toBeNull()
  })
})
