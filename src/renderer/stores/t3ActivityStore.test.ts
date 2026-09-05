import { beforeEach, expect, it } from 'vitest'
import { useT3ActivityStore } from './t3ActivityStore'

beforeEach(() => useT3ActivityStore.setState({ instances: {}, panels: {} }))
it('isolates equal thread ids across runtimes/checkouts and retains other panels on close', () => {
  const store = useT3ActivityStore.getState()
  store.bind('a', { workspaceId: 'ws', partition: 'local-repo', threadId: 'one' })
  store.bind('b', { workspaceId: 'ws', partition: 'local-repo', threadId: 'two' })
  store.bind('c', { workspaceId: 'ws', partition: 'remote-repo', threadId: 'one' })
  store.update('local-repo', { connected: true, revision: 1, threads: { one: { id: 'one', title: 'Local' } } })
  store.update('remote-repo', { connected: true, revision: 1, threads: { one: { id: 'one', title: 'Remote' } } })
  store.unbind('a')
  expect(useT3ActivityStore.getState().instances['local-repo'].threads.one.title).toBe('Local')
  store.unbind('b')
  expect(useT3ActivityStore.getState().instances['local-repo']).toBeUndefined()
  expect(useT3ActivityStore.getState().instances['remote-repo'].threads.one.title).toBe('Remote')
})

it('rejects stale snapshots and isolates a disconnected guest from sibling panels', () => {
  const store = useT3ActivityStore.getState()
  for (const id of ['a', 'b']) store.bind(id, { workspaceId: 'ws', partition: 'repo', threadId: id })
  store.update('repo', { connected: true, revision: 1, sequence: 2, threads: { a: { id: 'a', title: 'Fresh' } } }, 'a')
  store.update('repo', { connected: true, revision: 1, sequence: 1, threads: { a: { id: 'a', title: 'Old' } } }, 'b')
  store.update('repo', { connected: false, revision: 2, threads: {} }, 'b')
  const state = useT3ActivityStore.getState()
  expect(state.instances.repo.threads.a.title).toBe('Fresh')
  expect(state.panels.a.connected).toBe(true)
  expect(state.panels.b.connected).toBe(false)
})
