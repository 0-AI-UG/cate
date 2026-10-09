// Which thread each chat panel shows, for the agents service's t3 runner (its
// `T3PanelBindings`), read from the document: a chat record names its
// checkout (`cwd`, else its worktree, else the root) and its thread
// (`threadId`). The runner derives agent status, notifications and prompts
// from it. A fresh chat's first prompt goes through its page composer on the
// driving client, which holds the provider and model choice.

import type { SurfaceBroker } from '@panels/framework/runtime'
import type { T3PanelBindings } from '@services/agents/runtime'
import type { PanelRecord, WorkspaceDocument } from '@workspace/document/contract'
import { CHAT_SURFACE_SEND_TEXT, chatThreadId } from '../../contract'
import { chatDefinition } from '../../definition'

/** The checkout a chat record's conversation belongs to. */
export function chatCheckout(record: PanelRecord, doc: WorkspaceDocument, root: string): string {
  if (typeof record.fields.cwd === 'string' && record.fields.cwd) return record.fields.cwd
  const worktree = record.worktreeId ? doc.worktrees[record.worktreeId] : undefined
  return worktree?.path ?? root
}

export interface ChatThreadsDeps {
  root: string
  document: { get(): WorkspaceDocument; subscribe(listener: () => void): () => void }
  /** Page operations on the driving client (exists once panels attach). */
  surfaces(): Pick<SurfaceBroker, 'request'> | undefined
}

type Binding = { checkout: string; threadId?: string }

export interface ChatThreads extends T3PanelBindings {
  dispose(): void
}

export function createChatThreads(deps: ChatThreadsDeps): ChatThreads {
  const bindingOf = (record: PanelRecord, doc: WorkspaceDocument): Binding | undefined => {
    if (record.type !== chatDefinition.type) return undefined
    const threadId = chatThreadId(record)
    return { checkout: chatCheckout(record, doc, deps.root), ...(threadId ? { threadId } : {}) }
  }
  const all = (doc: WorkspaceDocument) => {
    const out = new Map<string, Binding>()
    for (const record of Object.values(doc.panels)) {
      const binding = bindingOf(record, doc)
      if (binding) out.set(record.id, binding)
    }
    return out
  }

  const listeners = new Set<(panelId: string) => void>()
  let known = all(deps.document.get())
  const stop = deps.document.subscribe(() => {
    const next = all(deps.document.get())
    const changed = new Set([...known.keys(), ...next.keys()].filter((panelId) => {
      const a = known.get(panelId)
      const b = next.get(panelId)
      return a?.checkout !== b?.checkout || a?.threadId !== b?.threadId
    }))
    known = next
    for (const panelId of changed) {
      for (const listener of [...listeners]) {
        try { listener(panelId) } catch { /* one listener must not break the others */ }
      }
    }
  })

  return {
    binding: (panelId) => known.get(panelId),
    panelIds: () => [...known.keys()],
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async sendFresh(panelId, prompt) {
      const surfaces = deps.surfaces()
      const feature = chatDefinition.surface?.ops[CHAT_SURFACE_SEND_TEXT]
      if (!surfaces || !feature) return false
      try {
        return (await surfaces.request(panelId, CHAT_SURFACE_SEND_TEXT, { text: prompt }, { feature })) === true
      } catch {
        return false
      }
    },
    dispose: stop,
  }
}
