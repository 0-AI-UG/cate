import { t3ThreadPollScript } from './t3ThreadState'
import { useT3ActivityStore, type T3Snapshot } from '../stores/t3ActivityStore'
import { perfCount } from './perf/perfClient'

interface Guest { executeJavaScript(script: string): Promise<unknown> }
interface Consumer { panelId: string; guest: Guest; onSnapshot: (snapshot: T3Snapshot) => void }
interface Subscription {
  partition: string
  consumers: Set<Consumer>
  failed: Set<Consumer>
  owner?: Consumer
  timer?: ReturnType<typeof setTimeout>
  revision?: number
  generation: number
  connected: boolean
}
const subscriptions = new Map<string, Subscription>()

function stopOwner(entry: Subscription): void {
  entry.generation++
  clearTimeout(entry.timer)
  const owner = entry.owner
  entry.owner = undefined
  entry.revision = undefined
  if (owner) {
    try { void owner.guest.executeJavaScript('window.__cateT3Threads?.dispose()').catch(() => {}) } catch { /* detached guest */ }
  }
}

async function poll(entry: Subscription): Promise<void> {
  const owner = entry.owner ?? entry.consumers.values().next().value
  if (!owner) return
  entry.owner = owner
  const generation = entry.generation
  try {
    perfCount('agentMetadataPoll')
    const snapshot = await owner.guest.executeJavaScript(t3ThreadPollScript(entry.revision)) as T3Snapshot | undefined
    if (generation !== entry.generation) return
    entry.failed.delete(owner)
    if (snapshot) {
      entry.revision = snapshot.revision
      entry.connected = snapshot.connected
      perfCount('agentMetadataThreads', Object.keys(snapshot.threads).length)
      const store = useT3ActivityStore.getState()
      store.update(entry.partition, snapshot, owner.panelId)
      const current = useT3ActivityStore.getState().instances[entry.partition]
      for (const participant of entry.consumers) {
        if (entry.failed.has(participant)) continue
        store.setConnected(participant.panelId, snapshot.connected)
        if (current && snapshot.connected) participant.onSnapshot(current)
      }
    }
  } catch {
    if (generation !== entry.generation) return
    entry.failed.add(owner)
    useT3ActivityStore.getState().setConnected(owner.panelId, false)
    // Rotate through ready guests, at a bounded cadence even if all fail.
    entry.consumers.delete(owner)
    entry.consumers.add(owner)
    stopOwner(entry)
    entry.connected = false
  }
  entry.timer = setTimeout(() => { void poll(entry) }, 1000)
}

/** One metadata socket/poll per harness partition in this renderer. Navigating
 * or closing the owning guest hands off to a sibling without losing metadata. */
export function subscribeT3Activity(partition: string, consumer: Consumer): () => void {
  let entry = subscriptions.get(partition)
  if (!entry) {
    entry = { partition, consumers: new Set(), failed: new Set(), generation: 0, connected: false }
    subscriptions.set(partition, entry)
  }
  const subscription = entry
  subscription.consumers.add(consumer)
  if (!subscription.owner && subscription.consumers.size === 1) void poll(subscription)
  else if (subscription.connected) {
    const snapshot = useT3ActivityStore.getState().instances[partition]
    useT3ActivityStore.getState().setConnected(consumer.panelId, true)
    if (snapshot) consumer.onSnapshot(snapshot)
  }
  return () => {
    subscription.consumers.delete(consumer)
    subscription.failed.delete(consumer)
    if (subscription.owner === consumer || subscription.consumers.size === 0) {
      stopOwner(subscription)
      if (subscription.consumers.size) void poll(subscription)
      else subscriptions.delete(partition)
    }
    useT3ActivityStore.getState().setConnected(consumer.panelId, false)
  }
}
