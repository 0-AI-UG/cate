// =============================================================================
// ChatView — the mode dispatcher for a single chat.
//
// Given a chatId it looks the chat up in chatsStore and renders the right leaf
// for its engine (chatMode): CodingChatView for 'coding', LoopChatView for
// 'loop'. It supplies the surface-agnostic props each leaf needs so a host
// (panel or sidebar) can render "the chat with this id" without knowing which
// engine drives it.
//
// The loop leaf transitively pulls the loop runtime (cateAgentController → xterm)
// via CateAgentComposer, so it is loaded LAZILY — a coding-only host that mounts
// ChatView never pulls xterm into its bundle.
// =============================================================================

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useChatsStore, chatMode } from '../stores/chatsStore'
import { useAgentStore } from '../../agent/renderer/agentStore'
import { CodingChatView, type CodingChatComposerExtras } from '../../agent/renderer/CodingChatView'
import type { ModelOption } from './ChatComposer'
import { useWorktrees } from '../stores/useWorktrees'
import { useWorktreeActions } from '../stores/useWorktreeActions'
import { useUIStore } from '../stores/uiStore'
import type { PrListItem } from '../sidebar/CreateWorktreeForm'
import type { AgentSlashCommand, Chat } from '../../shared/types'

// Lazy so ChatView (and any coding-only host) stays free of the loop runtime's
// xterm/cateAgentController graph until a loop chat actually renders.
const LoopChatView = React.lazy(() => import('../cateAgent/LoopChatView'))

// -----------------------------------------------------------------------------
// Coding host — gathers the composer data CodingChatView needs that isn't
// panel-specific. ChatView's coding path is the sidebar path: the worktree pill
// is read-only (switching restarts pi, which the panel owns), while models,
// send/steer/stop, images, slash, thinking, plan, compaction and fork all work
// off the chat's live agentKey slice.
// -----------------------------------------------------------------------------

const CodingChatHost: React.FC<{ chat: Chat; rootPath: string; workspaceId: string; surface: 'panel' | 'sidebar' }> = ({
  chat,
  rootPath,
  workspaceId,
  surface,
}) => {
  const agentKey = chat.agentKey ?? null

  // An adopted live coding chat is ready as soon as its slice exists (its pi is
  // already running); readyTick bumps once when that becomes true so the leaf's
  // polling effects re-run.
  const sliceExists = useAgentStore((s) => (agentKey ? !!s.panels[agentKey] : false))
  const [readyTick, setReadyTick] = useState(0)
  useEffect(() => {
    if (sliceExists) setReadyTick((n) => n + 1)
  }, [sliceExists])

  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const refreshModels = useCallback(async () => {
    try {
      const list = await window.electronAPI.agentListModels()
      setAvailableModels(list.map((m) => ({ provider: m.provider, model: m.id, label: m.label })))
    } catch {
      /* provider list unavailable — leave the last known set */
    }
  }, [])
  useEffect(() => {
    void refreshModels()
  }, [refreshModels])

  const [commands, setCommands] = useState<AgentSlashCommand[]>([])
  const refreshCommands = useCallback(async () => {
    if (!agentKey) return
    try {
      setCommands(await window.electronAPI.agentGetCommands(agentKey))
    } catch {
      /* pi not ready yet — the "/" popup refetches */
    }
  }, [agentKey])
  useEffect(() => {
    void refreshCommands()
  }, [refreshCommands])

  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  const joined = useWorktrees(rootPath, workspaceId)
  const worktrees = useMemo(() => joined.filter((w) => !w.isOrphan), [joined])
  const { createWorktree, checkoutPr } = useWorktreeActions(rootPath, workspaceId)

  const onSessionFile = useCallback(
    (_key: string, file: string) => {
      useChatsStore.getState().updateCodingChat(rootPath, chat.id, { sessionFile: file })
    },
    [rootPath, chat.id],
  )

  const composerExtras: CodingChatComposerExtras = {
    availableModels,
    refreshModels: () => { void refreshModels() },
    openProviderSettings: () => useUIStore.getState().openSettings('providers'),
    worktrees,
    // Read-only worktree pill: show the chat's checkout, but a pick is a no-op
    // here (a switch reinitialises pi, which only the panel host drives).
    selectedWorktreeId: chat.worktreeId ?? null,
    onPickWorktree: () => {},
    onCreateWorktree: async (name, baseRef) => (await createWorktree(name, baseRef))?.id ?? null,
    onCheckoutPr: async (pr: PrListItem) => (await checkoutPr(pr))?.id ?? null,
  }

  return (
    <CodingChatView
      agentKey={agentKey}
      workspaceId={workspaceId}
      rootPath={rootPath}
      surface={surface}
      sessionReady={sliceExists}
      readyTick={readyTick}
      onSessionFile={onSessionFile}
      commands={commands}
      onSlashOpen={() => { void refreshCommands() }}
      modelPickerOpen={modelPickerOpen}
      onModelPickerOpenChange={setModelPickerOpen}
      composerExtras={composerExtras}
    />
  )
}

export function ChatView({
  chatId,
  rootPath,
  workspaceId,
  surface,
}: {
  chatId: string
  rootPath: string
  workspaceId: string
  surface: 'panel' | 'sidebar'
}) {
  const chat = useChatsStore((s) => (s.chatsByRoot[rootPath] ?? []).find((c) => c.id === chatId))
  if (!chat) return null
  if (chatMode(chat) === 'coding') {
    return <CodingChatHost chat={chat} rootPath={rootPath} workspaceId={workspaceId} surface={surface} />
  }
  return (
    <Suspense fallback={null}>
      <LoopChatView wsId={workspaceId} rootPath={rootPath} chatId={chatId} />
    </Suspense>
  )
}
