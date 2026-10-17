// Agent chats in the app (`agents.watch`): each follows a panel's agent
// conversation (`watchAgentChat`), lays it out as the app shows it
// (`chatTimeline.ts`) and tells the app what changed as `chat` view events:
// the chat's state and its items from the first one that changed, so the
// app redraws only those.

import { watchAgentChat, type AgentChatHandle } from '@services/agents/client'
import type { MobileBridge, MobileChat, MobileViewEvent } from '../contract'
import { createChatTimeline } from './chatTimeline'

export interface MobileConversations {
  watch(params: { viewId: string; workspaceId: string; panelId: string; pending?: string }): void
  unwatch(viewId: string): void
  /** The chat's prompt went out (`sent`) or did not go through. */
  sent(viewId: string, prompt: string): void
  unsent(viewId: string): void
  /** A prompt that goes out once the agent can take it. */
  queue(viewId: string, prompt: string): void
  unqueue(viewId: string): string | null
}

export function createMobileConversations(bridge: MobileBridge): MobileConversations {
  const watches = new Map<string, { handle: AgentChatHandle; stop(): void }>()

  return {
    watch({ viewId, workspaceId, panelId, pending }) {
      watches.get(viewId)?.stop()
      const handle = watchAgentChat(workspaceId, panelId)
      const timeline = createChatTimeline()
      let shown: MobileChat | null = null
      let shownItems: string[] = []
      let recheck: ReturnType<typeof setTimeout> | null = null
      const emit = (event: MobileViewEvent) => {
        void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
      }
      const update = () => {
        if (recheck) clearTimeout(recheck)
        recheck = null
        const now = Date.now()
        const { chat, recheckAt } = timeline.update(handle.get(), now)
        if (recheckAt !== null) recheck = setTimeout(update, Math.max(0, recheckAt - now))
        const items = chat.items.map((item) => JSON.stringify(item))
        let from = 0
        while (from < items.length && from < shownItems.length && items[from] === shownItems[from]) from++
        const before = shown
        const same = before !== null && from === items.length && from === shownItems.length
          && before.loaded === chat.loaded && before.status === chat.status && before.canReceivePrompt === chat.canReceivePrompt
          && before.queued === chat.queued && JSON.stringify(before.turn) === JSON.stringify(chat.turn)
        shown = chat
        shownItems = items
        if (same) return
        emit({ kind: 'chat', ...chat, from, items: chat.items.slice(from) })
      }
      const off = handle.subscribe(update)
      watches.set(viewId, {
        handle,
        stop() {
          off()
          if (recheck) clearTimeout(recheck)
          handle.release()
        },
      })
      if (pending) handle.sent(pending)
      update()
    },
    unwatch(viewId) {
      watches.get(viewId)?.stop()
      watches.delete(viewId)
    },
    sent: (viewId, prompt) => watches.get(viewId)?.handle.sent(prompt),
    unsent: (viewId) => watches.get(viewId)?.handle.unsent(),
    queue: (viewId, prompt) => watches.get(viewId)?.handle.queue(prompt),
    unqueue: (viewId) => watches.get(viewId)?.handle.unqueue() ?? null,
  }
}
