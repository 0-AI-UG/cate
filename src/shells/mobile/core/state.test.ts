import { expect, it } from 'vitest'
import { connectionOf } from './state'

it('keeps compatible shared releases usable, and blocks a sole client awaiting confirmation', () => {
  const state = { kind: 'connected', runtimeVersion: '2.0.3' } as const
  expect(connectionOf(state, '2.0.4')).toMatchObject({ usable: true, actions: [], updating: false })
  expect(connectionOf(state, '2.0.4', false, false, { update: 'runtime', runtimeVersion: '2.0.3', appVersion: '2.0.4' }))
    .toMatchObject({ usable: false, actions: ['updateRuntime'] })
})

it('blocks interaction while updating, reconnecting, or using an incompatible protocol', () => {
  expect(connectionOf({ kind: 'connected', runtimeVersion: '2.0.4' }, '2.0.4', false, true)).toMatchObject({ usable: false, updating: true })
  expect(connectionOf({ kind: 'offline', lastSeen: 1, retrying: true }, '2.0.4').usable).toBe(false)
  expect(connectionOf({ kind: 'incompatible', runtimeVersion: '2.0.3' }, '2.0.4')).toMatchObject({ usable: false, actions: ['updateRuntime'] })
})
