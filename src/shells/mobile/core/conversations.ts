// Agent chats in the app (`agents.watch`): each follows a panel's agent
// conversation (`watchAgentChat`), lays it out as the app shows it
// (`chatTimeline.ts`) and tells the app what changed as `chat` view events:
// the chat's state and its items from the first one that changed, so the
// app redraws only those.

import { watchAgentChat } from '@services/agents/client'
import type { MobileBridge, MobileChat, MobileViewEvent } from '../contract'
import { createChatTimeline } from './chatTimeline'

export interface MobileConversations {
  /** `pending`: a new agent's first prompt, on its way with the agent. */
  watch(params: { viewId: string; workspaceId: string; panelId: string; pending?: string }): void
  unwatch(viewId: string): void
}

export function createMobileConversations(bridge: MobileBridge): MobileConversations {
  const watches = new Map<string, { stop(): void }>()

  return {
    watch({ viewId, workspaceId, panelId, pending }) {
      watches.get(viewId)?.stop()
      const handle = watchAgentChat(workspaceId, panelId)
      const timeline = createChatTimeline(pending ?? null)
      let shown: MobileChat | null = null
      let shownItems: string[] = []
      const emit = (event: MobileViewEvent) => {
        void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
      }
      const update = () => {
        const chat = timeline.update(handle.get())
        const items = chat.items.map((item) => JSON.stringify(item))
        let from = 0
        while (from < items.length && from < shownItems.length && items[from] === shownItems[from]) from++
        const before = shown
        const same = before !== null && from === items.length && from === shownItems.length
          && before.loaded === chat.loaded && before.status === chat.status && before.canReceivePrompt === chat.canReceivePrompt
          && JSON.stringify(before.queued) === JSON.stringify(chat.queued) && JSON.stringify(before.failed) === JSON.stringify(chat.failed)
          && JSON.stringify(before.turn) === JSON.stringify(chat.turn)
        shown = chat
        shownItems = items
        if (same) return
        emit({ kind: 'chat', ...chat, from, items: chat.items.slice(from) })
      }
      const off = handle.subscribe(update)
      watches.set(viewId, {
        stop() {
          off()
          handle.release()
        },
      })
      update()
    },
    unwatch(viewId) {
      watches.get(viewId)?.stop()
      watches.delete(viewId)
    },
  }
}
