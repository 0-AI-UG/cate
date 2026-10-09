import { describe, expect, it } from 'vitest'
import { connectionStatus, relativeTime } from './status'

const starts = { startsRuntime: true }
const paired = { startsRuntime: false }

describe('connection status', () => {
  it('says when an offline runtime was last seen', () => {
    const now = 10 * 60_000
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(connectionStatus({ kind: 'offline', lastSeen: now - 2 * 3_600_000, retrying: true }, { ...paired, now })).toMatchObject({
      title: 'Offline',
      message: 'Last connected 2 hours ago. Cate keeps trying.',
      remedies: ['retry', 'forget'],
    })
  })

  it('keeps socket paths, errno codes and timings out of the message', () => {
    const status = connectionStatus({ kind: 'offline', lastSeen: null, retrying: true, error: 'runtime did not answer at /h/.cate/workspaces/x/runtime.sock within 10000 ms: connect ENOENT' }, starts)
    expect(status).toEqual({ title: 'Could not start', message: 'The workspace runtime did not start. Cate keeps trying.', remedies: ['retry', 'remove'] })
    expect(connectionStatus({ kind: 'offline', lastSeen: null, retrying: true, error: 'u@box refused the login.' }, starts)?.message)
      .toBe('The workspace runtime did not start: u@box refused the login. Cate keeps trying.')
  })

  it('names a folder that is gone and offers to remove it', () => {
    expect(connectionStatus({ kind: 'offline', lastSeen: null, retrying: true, error: "ENOENT: no such file or directory, realpath '/p/app'" }, starts)).toMatchObject({
      title: 'Folder not found',
      remedies: ['remove', 'retry'],
    })
  })

  it('offers a start only where the transport can start the runtime', () => {
    expect(connectionStatus({ kind: 'stopped' }, starts)?.remedies).toEqual(['start'])
    expect(connectionStatus({ kind: 'stopped' }, paired)?.remedies).toEqual(['retry', 'forget'])
  })

  it('offers the way out of every refusal', () => {
    expect(connectionStatus({ kind: 'refused', message: 'nested', nestedIn: '/p' }, starts)?.remedies).toEqual(['openNested', 'retry', 'remove'])
    expect(connectionStatus({ kind: 'refused', message: 'no', unpaired: true }, paired)?.remedies).toEqual(['pair', 'forget'])
    expect(connectionStatus({ kind: 'refused', message: 'no' }, paired)?.remedies).toEqual(['retry'])
  })

  it('resolves an incompatible runtime and stays quiet when connected', () => {
    expect(connectionStatus({ kind: 'incompatible', runtimeVersion: '1.9.0' }, paired)).toMatchObject({ message: expect.stringContaining('1.9.0'), remedies: ['resolve'] })
    expect(connectionStatus({ kind: 'connected' }, paired)).toBeNull()
  })
})
