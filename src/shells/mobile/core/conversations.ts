// Agent chats in the app (`agents.watch`): each follows a panel's agent
// conversation (`watchAgentChat`), lays it out as the app shows it
// (`chatTimeline.ts`) and tells the app what changed as `chat` view events:
// the chat's state and its items from the first one that changed, so the
// app redraws only those. A long chat opens with its latest messages only;
// the app asks for earlier ones (`agents.more`) as it is scrolled up, so it
// never lays out, nor gets, all of it.

import { watchAgentChat } from '@services/agents/client'
import type { MobileBridge, MobileChat, MobileChatItem, MobileViewEvent } from '../contract'
import { createChatTimeline } from './chatTimeline'

/** Messages a chat opens with, and adds each time it is scrolled up. */
export const CHAT_PAGE = 20

export interface MobileConversations {
  /** `pending`: a new agent's first prompt, on its way with the agent. */
  watch(params: { viewId: string; workspaceId: string; panelId: string; pending?: string }): void
  unwatch(viewId: string): void
  /** Shows the chat's earlier page too. */
  more(viewId: string): void
}

/** Where the items of message `start` and on begin (its step group comes
 *  first); -1 when there is no such message. */
const windowStart = (items: MobileChatItem[], start: number): number =>
  start === 0 ? 0 : items.findIndex((item) => item.id === `s${start}` || item.id === `m${start}`)

export function createMobileConversations(bridge: MobileBridge): MobileConversations {
  const watches = new Map<string, { stop(): void; more(): void }>()

  return {
    watch({ viewId, workspaceId, panelId, pending }) {
      watches.get(viewId)?.stop()
      const handle = watchAgentChat(workspaceId, panelId)
      const timeline = createChatTimeline(pending ?? null)
      /** The first message shown; null until the conversation was read. */
      let start: number | null = null
      let shown: (MobileChat & { earlier: boolean }) | null = null
      let shownItems: string[] = []
      const emit = (event: MobileViewEvent) => {
        void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
      }
      const update = () => {
        const conversation = handle.get()
        const chat = timeline.update(conversation)
        const messages = conversation?.messages.length ?? 0
        if (start === null && chat.loaded) start = Math.max(0, messages - CHAT_PAGE)
        let first = windowStart(chat.items, start ?? 0)
        // Fewer messages than before (a cleared conversation): its latest again.
        if (first < 0) {
          start = Math.max(0, messages - CHAT_PAGE)
          first = windowStart(chat.items, start)
        }
        const window = { ...chat, items: chat.items.slice(first), earlier: first > 0 }
        const items = window.items.map((item) => JSON.stringify(item))
        let from = 0
        while (from < items.length && from < shownItems.length && items[from] === shownItems[from]) from++
        const before = shown
        const same = before !== null && from === items.length && from === shownItems.length
          && before.loaded === window.loaded && before.status === window.status && before.canReceivePrompt === window.canReceivePrompt
          && before.earlier === window.earlier
          && JSON.stringify(before.queued) === JSON.stringify(window.queued) && JSON.stringify(before.failed) === JSON.stringify(window.failed)
          && JSON.stringify(before.turn) === JSON.stringify(window.turn)
        shown = window
        shownItems = items
        if (same) return
        emit({ kind: 'chat', ...window, from, items: window.items.slice(from) })
      }
      const off = handle.subscribe(update)
      watches.set(viewId, {
        stop() {
          off()
          handle.release()
        },
        more() {
          if (!start) return
          start = Math.max(0, start - CHAT_PAGE)
          update()
        },
      })
      update()
    },
    unwatch(viewId) {
      watches.get(viewId)?.stop()
      watches.delete(viewId)
    },
    more(viewId) {
      watches.get(viewId)?.more()
    },
  }
}
