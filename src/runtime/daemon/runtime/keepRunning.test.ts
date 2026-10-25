import { expect, it } from 'vitest'
import type { KeepRunningTrigger } from '../contract'
import { createBusyRegistry } from './busy'
import { createKeepRunning, IN_USE_MS, type KeepRunningClient } from './keepRunning'

function setup(triggers: KeepRunningTrigger[]) {
  const state = { agents: false, commands: false, clients: [] as KeepRunningClient[], now: 1_000_000 }
  const work = createBusyRegistry()
  work.contribute('agents', () => state.agents)
  work.contribute('commands', () => state.commands)
  const held = createKeepRunning({ triggers: () => triggers, work, clients: () => state.clients, now: () => state.now })
  return { state, held }
}

it('holds only for the work the triggers pick', () => {
  const agents = setup(['agents'])
  agents.state.commands = true
  expect(agents.held()).toBe(false)
  agents.state.agents = true
  expect(agents.held()).toBe(true)

  const commands = setup(['commands'])
  commands.state.agents = true
  expect(commands.held()).toBe(false)
  commands.state.commands = true
  expect(commands.held()).toBe(true)
})

it('holds while a client is attentive and acted lately, whatever client it is', () => {
  const t = setup(['clients'])
  t.state.clients = [{ attentive: true, lastActiveAt: t.state.now - IN_USE_MS }]
  expect(t.held()).toBe(false)
  t.state.clients = [{ attentive: false, lastActiveAt: t.state.now }]
  expect(t.held()).toBe(false)
  t.state.clients = [{ attentive: true, lastActiveAt: t.state.now - IN_USE_MS + 1 }]
  expect(t.held()).toBe(true)
  expect(setup([]).held()).toBe(false)
})

it('always holds with `always`, never with no trigger', () => {
  expect(setup(['always']).held()).toBe(true)
  const none = setup([])
  none.state.agents = true
  none.state.commands = true
  none.state.clients = [{ attentive: true, lastActiveAt: none.state.now }]
  expect(none.held()).toBe(false)
})
