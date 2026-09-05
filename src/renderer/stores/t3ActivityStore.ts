import { create } from 'zustand'
import type { T3Thread } from '../lib/t3ThreadState'

export interface T3Snapshot { connected: boolean; threads: Record<string, T3Thread>; revision: number; sequence?: number }
interface Binding { workspaceId: string; partition: string; threadId?: string; connected?: boolean }
interface T3ActivityStore {
  // Partition hashes runtime + checkout. Thread ids are only unique within that instance.
  instances: Record<string, T3Snapshot>
  panels: Record<string, Binding>
  bind: (panelId: string, binding: Binding) => void
  unbind: (panelId: string) => void
  update: (partition: string, snapshot: T3Snapshot, panelId?: string) => void
}
export const useT3ActivityStore = create<T3ActivityStore>((set) => ({
  instances: {}, panels: {},
  bind: (panelId, binding) => set((s) => ({ panels: { ...s.panels, [panelId]: binding } })),
  unbind: (panelId) => set((s) => {
    const panels = { ...s.panels }; const partition = panels[panelId]?.partition; delete panels[panelId]
    const instances = { ...s.instances }
    if (partition && !Object.values(panels).some((p) => p.partition === partition)) delete instances[partition]
    return { panels, instances }
  }),
  update: (partition, snapshot, panelId) => set((s) => {
    const binding = panelId ? s.panels[panelId] : undefined
    if (panelId && binding?.partition !== partition) return s
    const panels = panelId && binding && binding.connected !== snapshot.connected
      ? { ...s.panels, [panelId]: { ...binding, connected: snapshot.connected } } : s.panels
    const previous = s.instances[partition]
    // Connections are per guest; thread state is shared and ordered by T3's sequence.
    const accept = snapshot.connected && (!previous || (snapshot.sequence ?? 0) >= (previous.sequence ?? 0))
    const instances = accept && JSON.stringify(previous) !== JSON.stringify(snapshot)
      ? { ...s.instances, [partition]: snapshot } : s.instances
    return panels === s.panels && instances === s.instances ? s : { panels, instances }
  }),
}))
