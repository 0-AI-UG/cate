// =============================================================================
// useDurableCodingChat — gather the read-only-surface composer data a coding chat
// needs, then drive it via useCodingChat.
//
// This is the gathering path for a surface that renders a durable coding chat
// WITHOUT owning its pi lifecycle: the worktree pill is READ-ONLY (a switch
// reinitialises pi, which only the AgentPanel drives), while models, slash
// commands, send/steer/stop, images, thinking, plan, compaction and fork all work
// off the chat's live agentKey slice.
//
// It returns the useCodingChat result verbatim, so its host — the Cate Agent
// sidebar's SPLIT transcript + floating composer — drives a coding chat from one
// subscription without duplicating the AgentPanel's plumbing.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useChatsStore } from '../stores/chatsStore'
import { useAgentStore } from '../../agent/renderer/agentStore'
import { useCodingChat, type CodingChatComposerExtras } from '../../agent/renderer/useCodingChat'
import type { ModelOption } from './ChatComposer'
import { useWorktrees } from '../stores/useWorktrees'
import { useWorktreeActions } from '../stores/useWorktreeActions'
import { useUIStore } from '../stores/uiStore'
import type { PrListItem } from '../sidebar/CreateWorktreeForm'
import type { AgentSlashCommand } from '../../shared/types'

export interface UseDurableCodingChatParams {
  /** The durable chatsStore record this hook drives. */
  chatId: string
  /** Its pi session key. Null during the brief window before the host resolves an
   *  active chat. */
  agentKey: string | null
  /** The checkout the chat belongs to — shown in the (read-only) worktree pill. */
  worktreeId: string | null
  rootPath: string
  workspaceId: string
}

export function useDurableCodingChat({
  chatId,
  agentKey,
  worktreeId,
  rootPath,
  workspaceId,
}: UseDurableCodingChatParams): ReturnType<typeof useCodingChat> {
  // An adopted live coding chat is ready as soon as its slice exists (its pi is
  // already running); readyTick bumps once when that becomes true so the polling
  // effects re-run.
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
      useChatsStore.getState().updateCodingChat(rootPath, chatId, { sessionFile: file })
    },
    [rootPath, chatId],
  )

  const composerExtras: CodingChatComposerExtras = {
    availableModels,
    refreshModels: () => { void refreshModels() },
    openProviderSettings: () => useUIStore.getState().openSettings('providers'),
    worktrees,
    // Read-only worktree pill: show the chat's checkout, but a pick is a no-op
    // here (a switch reinitialises pi, which only the panel host drives).
    selectedWorktreeId: worktreeId,
    onPickWorktree: () => {},
    onCreateWorktree: async (name, baseRef) => (await createWorktree(name, baseRef))?.id ?? null,
    onCheckoutPr: async (pr: PrListItem) => (await checkoutPr(pr))?.id ?? null,
  }

  return useCodingChat({
    agentKey,
    workspaceId,
    rootPath,
    sessionReady: sliceExists,
    readyTick,
    onSessionFile,
    commands,
    onSlashOpen: () => { void refreshCommands() },
    modelPickerOpen,
    onModelPickerOpenChange: setModelPickerOpen,
    composerExtras,
  })
}
