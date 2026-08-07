// One durable chat backed by one main-agent Pi session.

import React from 'react'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useCodingStore } from './codingStore'
import { useComposerModels } from '../../renderer/chat/useComposerModels'
import { useComposerWorktrees } from '../../renderer/chat/useComposerWorktrees'
import { useUIStore } from '../../renderer/stores/uiStore'
import { useAppStore } from '../../renderer/stores/appStore'
import type { CodingSlashCommand } from '../../shared/types'
import { resolveWorktree } from '../../shared/worktrees'
import { CodingChatView } from './CodingChatView'
import { CateAgentComposer } from './CateAgentComposer'
import {
  directAgentKey,
  ensureDirectChatSession,
  persistDirectSessionFile,
} from './directChatSession'
import { codingClient } from './codingClient'
import { CateAgentEmptyState } from './CateAgentEmptyState'

export const CateAgentChatView: React.FC<{
  wsId: string
  rootPath: string
  chatId: string | null
  onChatCreated?: (chatId: string) => void
  /** Set only when rendered inside an Agent panel; absent means sidebar. */
  hostPanelId?: string
}> = ({ wsId, rootPath, chatId, onChatCreated, hostPanelId }) => {
  const chat = useChatsStore((state) => chatId
    ? (state.chatsByRoot[rootPath] ?? []).find((candidate) => candidate.id === chatId)
    : undefined)

  // The first send mints a durable record; every later turn uses that session.
  if (!chat) {
    return (
      <CateAgentEmptyState>
        <CateAgentComposer
          wsId={wsId}
          rootPath={rootPath}
          chatId={null}
          onChatCreated={onChatCreated}
          hostPanelId={hostPanelId}
        />
      </CateAgentEmptyState>
    )
  }

  return (
    <DirectCateChatView
      wsId={wsId}
      rootPath={rootPath}
      chatId={chat.id}
    />
  )
}

const DirectCateChatView: React.FC<{
  wsId: string
  rootPath: string
  chatId: string
}> = ({
  wsId,
  rootPath,
  chatId,
}) => {
  const chat = useChatsStore((state) => (state.chatsByRoot[rootPath] ?? []).find((candidate) => candidate.id === chatId))
  const agentKey = directAgentKey(chatId)
  const sliceExists = useCodingStore((state) => !!state.panels[agentKey])
  const [ready, setReady] = React.useState(sliceExists)
  const [readyTick, setReadyTick] = React.useState(0)
  const [commands, setCommands] = React.useState<CodingSlashCommand[]>([])
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false)
  const [targetId, setTargetId] = React.useState<string | null>(
    () => chat?.worktreeId ?? null,
  )
  const { models, refreshModels } = useComposerModels()
  const { worktrees, onCreateWorktree, onCheckoutPr } = useComposerWorktrees({ rootPath, workspaceId: wsId })
  const worktreeMetas = useAppStore((state) => state.workspaces.find((workspace) => workspace.id === wsId)?.worktrees)
  const directCwd = resolveWorktree(targetId ?? undefined, worktreeMetas)?.path ?? rootPath

  React.useEffect(() => {
    setTargetId(chat?.worktreeId ?? null)
  }, [chat?.worktreeId, chatId])

  React.useEffect(() => {
    if (!chat) return
    let cancelled = false
    void ensureDirectChatSession(chat, wsId, rootPath, directCwd).then((ok) => {
      if (cancelled) return
      setReady(ok)
      setReadyTick((value) => value + 1)
    })
    return () => { cancelled = true }
  }, [chat?.id, directCwd, rootPath, wsId])

  const pickWorktree = React.useCallback(async (id: string) => {
    if (!chat) return
    const cwd = resolveWorktree(id, worktreeMetas)?.path ?? worktrees.find((worktree) => worktree.id === id)?.path ?? rootPath
    setTargetId(id)
    useChatsStore.getState().patchChat(rootPath, chatId, { worktreeId: id })
    setReady(false)
    try {
      // Pi may have learned its session path since the last stats refresh. Save
      // it before restarting so the same transcript resumes in the new cwd.
      try {
        const state = await window.electronAPI.agentGetState(agentKey)
        if (state.sessionFile) persistDirectSessionFile(rootPath, chatId, state.sessionFile)
      } catch {
        // A brand-new empty session may not answer state yet; it is still safe
        // to restart because there is no turn to recover.
      }
      await codingClient.interrupt(agentKey).catch(() => {})
      await codingClient.dispose(agentKey)
      useCodingStore.getState().dispose(agentKey)
      const current = useChatsStore.getState().getChat(rootPath, chatId) ?? chat
      const ok = await ensureDirectChatSession(current, wsId, rootPath, cwd)
      setReady(ok)
      setReadyTick((value) => value + 1)
    } catch {
      setReady(false)
    }
  }, [agentKey, chat, chatId, rootPath, worktreeMetas, worktrees, wsId])

  const refreshCommands = React.useCallback(async () => {
    if (!ready && !sliceExists) return
    try {
      setCommands(await window.electronAPI.agentGetCommands(agentKey))
    } catch {
      // Session startup may still be in flight; opening slash completion retries.
    }
  }, [agentKey, ready, sliceExists])

  React.useEffect(() => {
    void refreshCommands()
  }, [refreshCommands])

  if (!chat) return null
  return (
    <CodingChatView
      agentKey={agentKey}
      workspaceId={wsId}
      rootPath={rootPath}
      surface="cate"
      sessionReady={ready || sliceExists}
      readyTick={readyTick}
      onSessionFile={(_key, file) => persistDirectSessionFile(rootPath, chatId, file)}
      commands={commands}
      onSlashOpen={() => { void refreshCommands() }}
      modelPickerOpen={modelPickerOpen}
      onModelPickerOpenChange={setModelPickerOpen}
      composerExtras={{
        availableModels: models,
        refreshModels,
        openProviderSettings: () => useUIStore.getState().openSettings('cate agent'),
        worktrees,
        selectedWorktreeId: targetId,
        onPickWorktree: (id) => { void pickWorktree(id) },
        onCreateWorktree,
        onCheckoutPr,
      }}
    />
  )
}
