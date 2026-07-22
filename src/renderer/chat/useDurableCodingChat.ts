// =============================================================================
// useDurableCodingChat — gather the read-only-surface composer data a coding chat
// needs, then drive it via useCodingChat.
//
// This is the gathering path for a surface that renders a durable coding chat
// WITHOUT owning its pi lifecycle: the worktree pill is READ-ONLY (a switch
// reinitialises pi, which only the CateAgentPanel drives), while models, slash
// commands, send/steer/stop, images, thinking, plan, compaction and fork all work
// off the chat's live agentKey slice.
//
// It returns the useCodingChat result verbatim, so its host — the Cate Agent
// sidebar's SPLIT transcript + floating composer — drives a coding chat from one
// subscription without duplicating the CateAgentPanel's plumbing.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatsStore } from '../stores/chatsStore'
import { useCodingStore } from '../../cateAgent/renderer/codingStore'
import { resumeCodingChat } from '../../cateAgent/renderer/codingSessionRegistry'
import { useCodingChat, type CodingChatComposerExtras } from '../../cateAgent/renderer/useCodingChat'
import { useComposerModels } from './useComposerModels'
import { useComposerWorktrees } from './useComposerWorktrees'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { resolveWorktree } from '../../shared/worktrees'
import type { CodingSlashCommand } from '../../shared/types'

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
  const sliceExists = useCodingStore((s) => (agentKey ? !!s.panels[agentKey] : false))
  const [readyTick, setReadyTick] = useState(0)
  useEffect(() => {
    if (sliceExists) setReadyTick((n) => n + 1)
  }, [sliceExists])

  // Resume a DEAD coding chat's pi. Today a live slice is adopted by reference, but
  // a chat whose pi died (app restart, or it only ever ran in a now-closed panel)
  // has an agentKey with no slice, so the sidebar would show an empty transcript
  // and never respawn pi. Bring it back through the SAME primitive the panel uses:
  // init the slice, replay the transcript, respawn pi under its existing key.
  //
  // The cwd is the chat's checkout path — resolved from the workspace's persisted
  // worktree metadata (available on mount, unlike the live git snapshot), mirroring
  // how CateAgentPanel derives its cwd. Read via a ref so a late worktree-list hydrate
  // doesn't re-key the effect. Keyed on the chat identity only, so
  // resumeCodingChat's synchronous init() flipping sliceExists can't re-fire it (or
  // cancel the in-flight resume); the guard below re-checks liveness at run time.
  const worktreeMetas = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.worktrees,
  )
  const worktreeMetasRef = useRef(worktreeMetas)
  worktreeMetasRef.current = worktreeMetas
  useEffect(() => {
    if (!agentKey) return
    if (useCodingStore.getState().panels[agentKey]) return // already live → adopt by ref
    const cwd = resolveWorktree(worktreeId ?? undefined, worktreeMetasRef.current)?.path ?? rootPath
    const signal = { cancelled: false }
    void resumeCodingChat(rootPath, chatId, cwd, workspaceId, signal)
    return () => { signal.cancelled = true }
  }, [chatId, agentKey, worktreeId, rootPath, workspaceId])

  const { models: availableModels, refreshModels } = useComposerModels()

  const [commands, setCommands] = useState<CodingSlashCommand[]>([])
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

  const { worktrees, onCreateWorktree, onCheckoutPr } = useComposerWorktrees({ rootPath, workspaceId })

  const onSessionFile = useCallback(
    (_key: string, file: string) => {
      useChatsStore.getState().updateCodingChat(rootPath, chatId, { sessionFile: file })
    },
    [rootPath, chatId],
  )

  const composerExtras: CodingChatComposerExtras = {
    availableModels,
    refreshModels,
    openProviderSettings: () => useUIStore.getState().openSettings('providers'),
    worktrees,
    // Read-only worktree pill: show the chat's checkout, but a pick is a no-op
    // here (a switch reinitialises pi, which only the panel host drives).
    selectedWorktreeId: worktreeId,
    onPickWorktree: () => {},
    onCreateWorktree,
    onCheckoutPr,
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
