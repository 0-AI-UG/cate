import { useT3ActivityStore } from '../stores/t3ActivityStore'

let unsubscribe: (() => void) | undefined

/** Feed useT3ActivityStore from main's T3 shell streams (once per window),
 *  and load the current snapshot of `partition` for a newly bound panel. */
export function observeT3Partition(partition: string): void {
  unsubscribe ??= window.electronAPI.onAgentHarnessThreadShells?.((snapshot) => useT3ActivityStore.getState().apply(snapshot))
  void window.electronAPI.agentHarnessThreadShells?.({ partition })
    .then((snapshot) => { if (snapshot) useT3ActivityStore.getState().apply(snapshot) })
    .catch(() => {})
}
