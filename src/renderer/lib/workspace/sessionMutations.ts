// Document buffers live outside Zustand. Publish edits through the same session
// scheduling boundary as layout changes, without copying text into UI state.
const listeners = new Set<() => void>()
export function notifySessionMutation(): void { for (const listener of listeners) listener() }
export function subscribeSessionMutations(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
