// =============================================================================
// LoopChatView — render + drive ONE loop (Cate Agent) chat.
//
// The loop counterpart to CodingChatView: given a chatId it renders that chat's
// typed transcript + run controls (via LoopTranscript) and the loop composer
// (CateAgentComposer), reading the chat from chatsStore by id rather than from
// cateAgentStore.activeChatId. It is the per-chat leaf the CateAgentPanel's loop-chat
// branch renders for a `mode: 'loop'` chat.
//
// The OBSERVER feed is per-workspace, not per-chat, so it deliberately lives
// elsewhere (CateAgentThread) — this view is one chat only.
//
// This module transitively pulls the loop runtime (cateAgentController → xterm)
// via CateAgentComposer, so the coding CateAgentPanel imports it lazily to keep xterm
// off its static bundle.
// =============================================================================

import React from 'react'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { LoopTranscript } from './CateAgentThread'
import { CateAgentComposer } from './CateAgentComposer'

const LoopChatView: React.FC<{ wsId: string; rootPath: string; chatId: string }> = ({ wsId, rootPath, chatId }) => {
  const chat = useChatsStore((s) => (s.chatsByRoot[rootPath] ?? []).find((c) => c.id === chatId))
  if (!chat) return null
  return (
    <>
      <LoopTranscript wsId={wsId} rootPath={rootPath} chat={chat} />
      <CateAgentComposer wsId={wsId} rootPath={rootPath} />
    </>
  )
}

export default LoopChatView
