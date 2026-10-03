// The chat panel type (architecture 11.3): shows t3-runner agent sessions,
// the T3 client in a webview. Pure.

import { channel } from '@kernel/rpc/contract'
import { storedShortcut } from '@kernel/interaction/contract'
import { definePanel } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import { CHAT_DEFAULT_TITLE, type ChatCreateOptions, type ChatOp, type ChatSnapshot } from './contract'

const chatFields = (options: ChatCreateOptions): JsonObject => ({
  ...(options.threadId ? { threadId: options.threadId } : {}),
  ...(options.cwd ? { cwd: options.cwd } : {}),
})

export const chatDefinition = definePanel({
  type: 'chat',
  label: 'T3 Code',
  icon: 't3',
  defaultSize: { width: 760, height: 480 },
  minimumSize: { width: 360, height: 320 },
  dropSize: { width: 520, height: 440 },
  canLiveOnCanvas: true,
  switchesWorktree: true,
  navigable: true,
  creation: { order: 4, title: 'New T3 Code Conversation', key: storedShortcut('a', { command: true, shift: true }), inWorktree: true },
  // Fixed, like the browser: moving a <webview> to another parent (even with
  // moveBefore) reloads its page, so an inline surface cannot survive a tab or
  // workspace switch.
  surface: { retention: 'recent' },
  opens: ['conversation'],
  defaultTitle: CHAT_DEFAULT_TITLE,
  fields: chatFields,
  channel: channel<ChatSnapshot, Partial<ChatSnapshot>, ChatOp>(),
  // Numbered ("T3 Code 2") so `cate` callers can address one panel.
  create: (options: ChatCreateOptions, kit) => {
    const record = kit.record('chat', {
      id: kit.newId(),
      title: options.title ?? kit.numberedTitle('chat', CHAT_DEFAULT_TITLE),
      worktreeId: options.worktreeId ?? kit.worktreeIdForPath(options.cwd),
      fields: chatFields(options),
    })
    return kit.add(record, options)
  },
  checkoutPath: (record) => typeof record.fields.cwd === 'string' ? record.fields.cwd : undefined,
  relation: { execution: true },
  commands: [{ id: 'chat.restart', title: 'Restart T3 Code', op: { kind: 'retry' } }],
})

export default chatDefinition
