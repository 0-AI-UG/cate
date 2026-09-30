// Which thread each chat panel shows, for the agents service's t3 runner
// (its `T3PanelBindings`): the runner derives agent status, notifications and
// prompt dispatch from it. Chat sessions keep their entry current.

export interface ChatBinding {
  checkout: string
  threadId?: string
}

export interface ChatBindings {
  set(panelId: string, binding: ChatBinding, sendFresh: (prompt: string) => Promise<boolean>): void
  delete(panelId: string): void
  binding(panelId: string): ChatBinding | undefined
  panelIds(): Iterable<string>
  onChange(listener: (panelId: string) => void): () => void
  /** A fresh chat's first prompt goes through its page composer. */
  sendFresh(panelId: string, prompt: string): Promise<boolean>
}

export function createChatBindings(): ChatBindings {
  const entries = new Map<string, { binding: ChatBinding; sendFresh: (prompt: string) => Promise<boolean> }>()
  const listeners = new Set<(panelId: string) => void>()
  const changed = (panelId: string) => {
    for (const listener of [...listeners]) {
      try { listener(panelId) } catch { /* one listener must not break the others */ }
    }
  }
  return {
    set(panelId, binding, sendFresh) {
      const previous = entries.get(panelId)?.binding
      entries.set(panelId, { binding, sendFresh })
      if (previous?.checkout !== binding.checkout || previous?.threadId !== binding.threadId) changed(panelId)
    },
    delete(panelId) {
      if (entries.delete(panelId)) changed(panelId)
    },
    binding: (panelId) => entries.get(panelId)?.binding,
    panelIds: () => [...entries.keys()],
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async sendFresh(panelId, prompt) {
      const entry = entries.get(panelId)
      return entry ? entry.sendFresh(prompt) : false
    },
  }
}
