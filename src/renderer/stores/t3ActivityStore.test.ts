import { beforeEach, expect, it } from 'vitest'
import { t3PanelActivity, t3PanelConnected, useT3ActivityStore } from './t3ActivityStore'

const snapshot = (partition: string, sequence: number, threads: Record<string, { id: string; title: string }>, connected = true) =>
  ({ partition, connected, sequence, threads })

beforeEach(() => useT3ActivityStore.setState({ instances: {}, panels: {} }))
it('isolates equal thread ids across runtimes/checkouts and retains other panels on close', () => {
  const store = useT3ActivityStore.getState()
  store.bind('a', { workspaceId: 'ws', partition: 'local-repo', threadId: 'one' })
  store.bind('b', { workspaceId: 'ws', partition: 'local-repo', threadId: 'two' })
  store.bind('c', { workspaceId: 'ws', partition: 'remote-repo', threadId: 'one' })
  store.apply(snapshot('local-repo', 1, { one: { id: 'one', title: 'Local' } }))
  store.apply(snapshot('remote-repo', 1, { one: { id: 'one', title: 'Remote' } }))
  store.unbind('a')
  expect(useT3ActivityStore.getState().instances['local-repo'].threads.one.title).toBe('Local')
  store.unbind('b')
  expect(useT3ActivityStore.getState().instances['local-repo']).toBeUndefined()
  expect(useT3ActivityStore.getState().instances['remote-repo'].threads.one.title).toBe('Remote')
})

it('ignores unobserved partitions and stale snapshots, and tracks harness connectivity', () => {
  const store = useT3ActivityStore.getState()
  store.apply(snapshot('elsewhere', 1, { a: { id: 'a', title: 'Not bound here' } }))
  expect(useT3ActivityStore.getState().instances.elsewhere).toBeUndefined()
  store.bind('a', { workspaceId: 'ws', partition: 'repo', threadId: 'a' })
  store.apply(snapshot('repo', 2, { a: { id: 'a', title: 'Fresh' } }))
  store.apply(snapshot('repo', 1, { a: { id: 'a', title: 'Old' } }))
  expect(useT3ActivityStore.getState().instances.repo.threads.a.title).toBe('Fresh')
  expect(t3PanelConnected(useT3ActivityStore.getState(), 'a')).toBe(true)
  expect(t3PanelActivity(useT3ActivityStore.getState(), 'a')).toBe('notRunning')
  store.apply(snapshot('repo', 2, { a: { id: 'a', title: 'Fresh' } }, false))
  expect(t3PanelConnected(useT3ActivityStore.getState(), 'a')).toBe(false)
  expect(t3PanelActivity(useT3ActivityStore.getState(), 'a')).toBeUndefined()
})

it('keeps unchanged threads referentially stable and skips no-op snapshots', () => {
  const store = useT3ActivityStore.getState()
  store.bind('p', { workspaceId: 'ws', partition: 'repo' })
  store.apply(snapshot('repo', 1, { a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'B' } }))
  const a = useT3ActivityStore.getState().instances.repo.threads.a
  store.apply(snapshot('repo', 2, { a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'New' } }))
  expect(useT3ActivityStore.getState().instances.repo.threads.a).toBe(a)
  const previous = useT3ActivityStore.getState()
  store.apply(snapshot('repo', 2, { a: { id: 'a', title: 'A' }, b: { id: 'b', title: 'New' } }))
  expect(useT3ActivityStore.getState()).toBe(previous)
  store.apply(snapshot('repo', 3, { a: { id: 'a', title: 'A' } }))
  expect(useT3ActivityStore.getState().instances.repo.threads).toEqual({ a })
})
