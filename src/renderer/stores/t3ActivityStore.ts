import { create } from 'zustand'
import type { T3ShellSnapshot, T3Thread } from '../../shared/t3Agent'
import type { AgentState } from '../../shared/types'
import { t3ThreadActivity } from '../lib/t3ThreadState'

interface Binding { workspaceId: string; partition: string; threadId?: string }
interface T3ActivityStore {
  // Partition hashes runtime + checkout. Thread ids are only unique within that instance.
  instances: Record<string, T3ShellSnapshot>
  panels: Record<string, Binding>
  bind: (panelId: string, binding: Binding) => void
  unbind: (panelId: string) => void
  /** Apply a full shell snapshot pushed by main (see main/t3Agent/threadShells.ts).
   *  Ignored for partitions no panel in this window is bound to, and when
   *  older than what is already held. */
  apply: (snapshot: T3ShellSnapshot) => void
}

/** Keep unchanged thread objects referentially stable across snapshots so
 *  selectors over one thread do not re-render on unrelated updates. */
function reuseUnchanged(previous: Record<string, T3Thread> | undefined, next: Record<string, T3Thread>): Record<string, T3Thread> {
  if (!previous) return next
  return Object.fromEntries(Object.entries(next).map(([id, thread]) => {
    const old = previous[id]
    return [id, old && JSON.stringify(old) === JSON.stringify(thread) ? old : thread]
  }))
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
  apply: (snapshot) => set((s) => {
    if (!Object.values(s.panels).some((binding) => binding.partition === snapshot.partition)) return s
    const previous = s.instances[snapshot.partition]
    if (previous && snapshot.sequence < previous.sequence) return s
    const next = { ...snapshot, threads: reuseUnchanged(previous?.threads, snapshot.threads) }
    if (previous && previous.connected === next.connected && previous.sequence === next.sequence
      && Object.keys(previous.threads).length === Object.keys(next.threads).length
      && Object.entries(next.threads).every(([id, thread]) => previous.threads[id] === thread)) return s
    return { instances: { ...s.instances, [snapshot.partition]: next } }
  }),
}))

/** The thread a T3 panel is bound to, when its harness has reported it. */
export function t3ThreadForPanel(state: Pick<T3ActivityStore, 'instances' | 'panels'>, panelId: string): T3Thread | undefined {
  const binding = state.panels[panelId]
  return binding?.threadId ? state.instances[binding.partition]?.threads[binding.threadId] : undefined
}

/** A T3 panel's live activity: its thread's state while the harness stream
 *  is live, undefined when nothing is observable. */
export function t3PanelActivity(state: Pick<T3ActivityStore, 'instances' | 'panels'>, panelId: string): AgentState | undefined {
  const thread = t3ThreadForPanel(state, panelId)
  return thread && t3PanelConnected(state, panelId) ? t3ThreadActivity(thread) : undefined
}

/** Whether a T3 panel's harness shell stream is live. */
export function t3PanelConnected(state: Pick<T3ActivityStore, 'instances' | 'panels'>, panelId: string): boolean {
  const binding = state.panels[panelId]
  return Boolean(binding && state.instances[binding.partition]?.connected)
}
