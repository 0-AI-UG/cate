// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { selectT3InfoByPanel } from './useAgentPanelInfo'
import { useT3ActivityStore } from '../stores/t3ActivityStore'

it('reports each bound T3 conversation independently and disconnected activity as unknown', () => {
  useT3ActivityStore.setState({ instances: {}, panels: {} })
  const store = useT3ActivityStore.getState()
  store.bind('first', { workspaceId: 'ws', partition: 'runtime-checkout', threadId: 'one' })
  store.bind('second', { workspaceId: 'ws', partition: 'runtime-checkout', threadId: 'two' })
  const snapshot = { connected: true, revision: 1, sequence: 1, threads: {
    one: { id: 'one', title: 'One', latestTurn: { state: 'running' } },
    two: { id: 'two', title: 'Two', hasPendingApprovals: true },
  } }
  store.update('runtime-checkout', snapshot, 'first')
  store.update('runtime-checkout', snapshot, 'second')
  let info = selectT3InfoByPanel(useT3ActivityStore.getState(), 'ws')
  expect(info.first.state).toBe('running')
  expect(info.second.state).toBe('waitingForInput')
  expect(selectT3InfoByPanel(useT3ActivityStore.getState(), 'other')).toEqual({})
  store.update('runtime-checkout', { ...snapshot, revision: 2, sequence: 2, threads: {
    ...snapshot.threads,
    one: { ...snapshot.threads.one, latestTurn: { state: 'completed' } },
  } }, 'first')
  info = selectT3InfoByPanel(useT3ActivityStore.getState(), 'ws')
  expect(info.first.state).toBe('waitingForInput')
  store.update('runtime-checkout', { connected: false, revision: 2, threads: {} }, 'second')
  info = selectT3InfoByPanel(useT3ActivityStore.getState(), 'ws')
  expect(info.first.state).toBe('waitingForInput')
  expect(info.second.state).toBeUndefined()
  expect(info.second.name).toContain('disconnected')
  useT3ActivityStore.setState({ instances: {}, panels: {} })
})
