import { expect, it, vi } from 'vitest'
import type { KeepRunningTrigger } from '@runtime/daemon/contract'
import { createAvailabilityHandlers, createMobileAvailability } from './availability'
import type { MobileWorkspaceSettings } from './workspaceSettings'

function setup(info: () => Promise<unknown>) {
  let triggers: KeepRunningTrigger[] = ['agents', 'commands', 'clients']
  const mirror = {
    get: () => triggers,
    set: vi.fn(async (_key: string, value: KeepRunningTrigger[]) => { triggers = value }),
  }
  const settings = { of: (id: string) => (id === 'ws' ? mirror : null), subscribe: () => () => {} } as unknown as MobileWorkspaceSettings
  let state = { kind: 'connecting' }
  const stateListeners = new Set<() => void>()
  const connection = {
    workspaceId: 'ws',
    runtime: { runtime: { info } },
    getState: () => state,
    subscribe: (fn: () => void) => { stateListeners.add(fn); return () => stateListeners.delete(fn) },
  }
  const connections = { getSnapshot: () => [connection], subscribe: () => () => {} }
  const availability = createMobileAvailability({ connections } as never, settings)
  const connect = async () => {
    state = { kind: 'connected' }
    for (const fn of stateListeners) fn()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { availability, settings, mirror, connect }
}

it('shows the close choice, and the machine once connected', async () => {
  const info = vi.fn(async () => ({ machineName: 'vps-1', machineSleeps: false }))
  const t = setup(info)
  expect(t.availability.whenClosed('ws')).toEqual({ choice: 'finish', commands: true, machine: null, machineSleeps: true })
  expect(info).not.toHaveBeenCalled()
  await t.connect()
  expect(t.availability.whenClosed('ws')).toEqual({ choice: 'finish', commands: true, machine: 'vps-1', machineSleeps: false })
  expect(t.availability.whenClosed('other')).toBeNull()
})

it('sets the choice as keepRunningWhile, and refuses without a connection', async () => {
  const t = setup(async () => ({}))
  const handlers = createAvailabilityHandlers(t.settings)
  await expect(handlers['runtime.setWhenClosed']({ workspaceId: 'ws', choice: 'finish', commands: false })).resolves.toEqual({ ok: true })
  expect(t.mirror.set).toHaveBeenLastCalledWith('keepRunningWhile', ['agents', 'clients'])
  expect(t.availability.whenClosed('ws')?.commands).toBe(false)
  await handlers['runtime.setWhenClosed']({ workspaceId: 'ws', choice: 'always', commands: true })
  expect(t.availability.whenClosed('ws')?.choice).toBe('always')
  await expect(handlers['runtime.setWhenClosed']({ workspaceId: 'other', choice: 'stop', commands: true })).resolves.toMatchObject({ ok: false })
})
