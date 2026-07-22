// =============================================================================
// CateAgentComposer — the sidebar's message composer. The markup is the shared
// ChatComposer (stacked card: textarea + control row, worktree card tucked
// under, upward-opening menus); this file owns the DATA: the shared draft, the
// model pref, the per-chat worktree target, send/stop.
//
// Only the capabilities this surface supports are wired: model pill, worktree
// card, send/stop. Images, slash commands, thinking level, plan mode, compaction
// and the stats chip stay unwired, so those controls don't render.
//
// The model picker writes the active chat's own model override (falling back to
// the global default when unset); Stop routes to cateAgentController.stop. The
// draft is shared with the sidebar card via the same per-workspace key, so an
// unsent message follows you.
// =============================================================================

import React from 'react'
import { ChatComposer, type ModelOption } from '../chat/ChatComposer'
import { sendCateAgentMessage } from './cateAgentSend'
import { cateAgentController } from './cateAgentController'
import { useCateAgentWs } from './cateAgentStore'
import { useChatsStore } from '../stores/chatsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorktrees } from '../stores/useWorktrees'
import { useWorktreeActions } from '../stores/useWorktreeActions'
import { getTargetWorktree, setTargetWorktree } from './cateAgentWorktreeTarget'
import { saveDefaultModel } from '../../agent/renderer/agentModelPrefs'

// --- draft (per-workspace key, so an unsent message follows you across chats) --
const draftKey = (wsId: string): string => `cate.agentDraft.${wsId}`
const loadDraft = (wsId: string): string => {
  try {
    return wsId ? localStorage.getItem(draftKey(wsId)) ?? '' : ''
  } catch {
    return ''
  }
}
const saveDraft = (wsId: string, value: string): void => {
  try {
    if (!wsId) return
    if (value) localStorage.setItem(draftKey(wsId), value)
    else localStorage.removeItem(draftKey(wsId))
  } catch {
    /* best-effort */
  }
}

export const CateAgentComposer: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const activeChat = cateAgent.activeChatId ? chats.find((c) => c.id === cateAgent.activeChatId) : undefined
  const running = activeChat?.run?.status === 'running'

  const [text, setText] = React.useState(() => loadDraft(wsId))

  const [models, setModels] = React.useState<ModelOption[]>([])
  // The global default a chat with no override inherits — reactive so a change in
  // Settings (or a front-door pick) re-renders the pill.
  const defaultModel = useSettingsStore((s) => s.agentDefaultModel)
  // The worktree the active chat works against (null = whatever is checked out).
  // Re-read whenever the chat changes — each chat remembers its own.
  const [targetId, setTargetId] = React.useState<string | null>(() => getTargetWorktree(cateAgent.activeChatId ?? ''))

  // The workspace's worktrees, from the same read-time join every other worktree
  // surface uses. Orphans (metadata whose checkout is gone) are not pickable.
  const joined = useWorktrees(rootPath, wsId)
  const worktrees = React.useMemo(() => joined.filter((w) => !w.isOrphan), [joined])
  const { createWorktree, checkoutPr } = useWorktreeActions(rootPath, wsId)

  // The provider-grouped model list (same source as the agent panel): once on
  // mount, and again whenever the menu opens so a provider signed in since then
  // shows up.
  const refreshModels = React.useCallback(() => {
    window.electronAPI
      .agentListModels()
      .then((list) => setModels(list.map((m) => ({ provider: m.provider, model: m.id, label: m.label }))))
      .catch(() => {})
  }, [])
  React.useEffect(() => {
    refreshModels()
  }, [refreshModels])

  // Follow the active chat: each chat remembers its own worktree.
  React.useEffect(() => {
    setTargetId(getTargetWorktree(cateAgent.activeChatId ?? ''))
  }, [cateAgent.activeChatId])

  const update = (value: string): void => {
    const normalized = value.replace(/\r\n?/g, '\n').replace(/^\n+/, '')
    setText(normalized)
    saveDraft(wsId, normalized)
  }
  const send = (): void => {
    const t = text.trim()
    if (!t) return
    sendCateAgentMessage(wsId, rootPath, t, targetId ?? undefined)
    update('')
  }

  // Pick the worktree for the active chat. Carried to a new chat on send() when
  // none is active yet (so a pick made before the first message still counts).
  const pickWorktree = (id: string): void => {
    setTargetId(id)
    if (cateAgent.activeChatId) setTargetWorktree(cateAgent.activeChatId, id)
  }

  // A chat's own model override, else the global default — so the pill and its
  // checkmark always name a real model (the fallback stays implicit), same as the
  // agent panel. At the front door (no active chat) only the default shows.
  const effectiveModel = activeChat?.model ?? defaultModel

  return (
    <ChatComposer
      draft={text}
      onChange={update}
      onSubmit={send}
      onStop={() => activeChat && cateAgentController.stop(wsId, activeChat.id)}
      disabled={false}
      running={running}
      placeholder="Message Cate…"
      // A message sent mid-run starts the next turn rather than steering the
      // live one, so Stop stays a control of its own.
      canSteer={false}
      models={models}
      modelTitle="Model for the Cate Agent"
      selectedModel={effectiveModel}
      onModelMenuOpen={refreshModels}
      onPickModel={(m) => {
        const next = { provider: m.provider, model: m.model }
        // A pick overrides just the active chat; at the front door (no chat yet)
        // it sets the global default the next new chat will inherit.
        if (activeChat) useChatsStore.getState().setChatModel(rootPath, activeChat.id, next)
        else saveDefaultModel(next)
      }}
      onManageModels={() => useUIStore.getState().openSettings('providers')}
      worktrees={worktrees}
      selectedWorktreeId={targetId}
      onPickWorktree={pickWorktree}
      worktreeMenuHeading="Work in…"
      worktreeTitle="Worktree this task branches off and lands back into"
      rootPath={rootPath}
      onCreateWorktree={async (name, baseRef) => (await createWorktree(name, baseRef))?.id ?? null}
      onCheckoutPr={async (pr) => (await checkoutPr(pr))?.id ?? null}
    />
  )
}
