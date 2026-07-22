// =============================================================================
// CateAgentComposer — the sidebar's message composer. The markup is the shared
// ChatComposer (stacked card: textarea + control row, worktree card tucked
// under, upward-opening menus); this file owns the DATA: the shared draft, the
// model pref, the per-chat worktree target, send/stop, attachments and the
// headless session controls. Both the floating panel and sidebar render this
// component, so the unified agent has one capability-complete composer.
//
// The model picker writes the active chat's own model override (falling back to
// the global default when unset); Stop routes to cateAgentController.stop. The
// draft is shared with the sidebar card via the same per-workspace key, so an
// unsent message follows you.
// =============================================================================

import React from 'react'
import { ChatComposer } from '../../renderer/chat/ChatComposer'
import { useComposerModels } from '../../renderer/chat/useComposerModels'
import { useComposerWorktrees } from '../../renderer/chat/useComposerWorktrees'
import { sendCateAgentMessage, sendDirectAgentMessage } from './cateAgentSend'
import { cateAgentController } from './cateAgentController'
import { useCateAgentWs } from './cateAgentStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { useSettingsStore } from '../../renderer/stores/settingsStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { getTargetWorktree, setTargetWorktree } from './cateAgentWorktreeTarget'
import { saveDefaultModel } from './codingModelPrefs'
import { useCodingStore } from './codingStore'
import { orchestratorPanelId } from './cateAgentSession'
import { buildFileMentions } from './codingDrop'
import {
  imageMimeForPath,
  readFileAsImage,
  readPathAsImage,
} from './CateAgentPanelChrome'
import { readCateFileLocation, readCateFilePaths } from '../../renderer/drag/fileDragPayload'
import type { CodingImageAttachment, CodingSlashCommand, CodingThinkingLevel } from '../../shared/types'

// --- draft (per-workspace key, so an unsent message follows you across chats) --
const draftKey = (wsId: string): string => `cate.cateAgentDraft.${wsId}`
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

export const CateAgentComposer: React.FC<{
  wsId: string
  rootPath: string
  /** undefined follows the workspace selection; null is an explicit new-chat surface. */
  chatId?: string | null
  onChatCreated?: (chatId: string) => void
}> = ({ wsId, rootPath, chatId, onChatCreated }) => {
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const selectedChatId = chatId === undefined ? cateAgent.activeChatId : chatId ?? ''
  const activeChat = selectedChatId ? chats.find((c) => c.id === selectedChatId) : undefined
  const panelId = activeChat ? orchestratorPanelId(activeChat.id) : ''
  const session = useCodingStore((s) => panelId ? s.panels[panelId] : undefined)
  const running = activeChat?.run?.status === 'running' || !!session?.running

  const [text, setText] = React.useState(() => loadDraft(wsId))
  const [images, setImages] = React.useState<CodingImageAttachment[]>([])
  const [commands, setCommands] = React.useState<CodingSlashCommand[]>([])
  const [pendingThinking, setPendingThinking] = React.useState<CodingThinkingLevel | null>(null)
  const [pendingPlan, setPendingPlan] = React.useState(false)
  const [pendingAutoCompaction, setPendingAutoCompaction] = React.useState(true)

  // The provider-grouped model list (same source as the agent panel): once on
  // mount, and again whenever the menu opens so a provider signed in since then
  // shows up.
  const { models, refreshModels } = useComposerModels()
  // The global default a chat with no override inherits — reactive so a change in
  // Settings (or a front-door pick) re-renders the pill.
  const defaultModel = useSettingsStore((s) => s.agentDefaultModel)
  // The worktree the active chat works against (null = whatever is checked out).
  // Re-read whenever the chat changes — each chat remembers its own.
  const [targetId, setTargetId] = React.useState<string | null>(() => getTargetWorktree(selectedChatId))

  // The workspace's worktrees + create/checkout adapters, shared with every other
  // chat composer. Orphans (metadata whose checkout is gone) are not pickable.
  const { worktrees, onCreateWorktree, onCheckoutPr } = useComposerWorktrees({ rootPath, workspaceId: wsId })

  // Follow the active chat: each chat remembers its own worktree.
  React.useEffect(() => {
    setTargetId(getTargetWorktree(selectedChatId))
  }, [selectedChatId])

  React.useEffect(() => {
    if (panelId) useCodingStore.getState().init(panelId)
  }, [panelId])

  const refreshSessionChrome = React.useCallback(async (): Promise<void> => {
    if (!activeChat || !panelId || !cateAgentController.hasChatSession(wsId, activeChat.id)) return
    try {
      const [stats, state, nextCommands] = await Promise.all([
        window.electronAPI.agentGetSessionStats(panelId),
        window.electronAPI.agentGetState(panelId),
        window.electronAPI.agentGetCommands(panelId),
      ])
      const store = useCodingStore.getState()
      store.setStats(panelId, stats)
      store.setThinkingLevel(panelId, state.thinkingLevel)
      store.setAutoCompactionEnabled(panelId, state.autoCompactionEnabled)
      setCommands(nextCommands)
    } catch {
      // Session creation and the first lifecycle event can race this refresh.
      // The next running/activity transition retries it.
    }
  }, [activeChat, panelId, wsId])

  React.useEffect(() => {
    void refreshSessionChrome()
  }, [refreshSessionChrome, running, cateAgent.activity])

  const update = (value: string): void => {
    const normalized = value.replace(/\r\n?/g, '\n').replace(/^\n+/, '')
    setText(normalized)
    saveDraft(wsId, normalized)
  }
  const send = (): void => {
    const t = text.trim()
    if (!t && images.length === 0) return
    const thinkingLevel = session?.thinkingLevel ?? pendingThinking ?? undefined
    const autoCompactionEnabled = session?.autoCompactionEnabled ?? pendingAutoCompaction
    const planMode = session
      ? session.extensionStatuses.some((status) => status.key === 'plan-mode')
      : pendingPlan
    const options = { images, thinkingLevel, autoCompactionEnabled, planMode }
    const directCwd = worktrees.find((worktree) => worktree.id === targetId)?.path
    const nextChatId = chatId
      ? sendCateAgentMessage(wsId, rootPath, t, targetId ?? undefined, chatId, options)
      : sendDirectAgentMessage(wsId, rootPath, t, targetId ?? undefined, options, directCwd)
    if (!activeChat) onChatCreated?.(nextChatId)
    update('')
    setImages([])
  }

  const addImage = React.useCallback((image: CodingImageAttachment) => {
    setImages((current) => [...current, image])
  }, [])

  const handlePaste = React.useCallback(async (event: React.ClipboardEvent) => {
    let attached = false
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (!file) continue
      const image = await readFileAsImage(file)
      if (image) {
        addImage(image)
        attached = true
      }
    }
    if (attached) event.preventDefault()
  }, [addImage])

  const handleDrop = React.useCallback(async (event: React.DragEvent) => {
    const paths = readCateFilePaths(event.dataTransfer)
    if (paths.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      const otherPaths: string[] = []
      for (const path of paths) {
        if (imageMimeForPath(path)) {
          const image = await readPathAsImage(path, wsId)
          if (image) addImage(image)
        } else {
          otherPaths.push(path)
        }
      }
      if (otherPaths.length > 0) {
        const mentions = buildFileMentions(otherPaths, readCateFileLocation(event.dataTransfer))
        update(text ? `${text}${text.endsWith(' ') ? '' : ' '}${mentions} ` : `${mentions} `)
      }
      return
    }
    if (!event.dataTransfer.files.length) return
    event.preventDefault()
    event.stopPropagation()
    for (const file of Array.from(event.dataTransfer.files)) {
      let image = await readFileAsImage(file)
      if (!image) {
        const path = window.electronAPI.getPathForFile?.(file)
        if (path && imageMimeForPath(path)) image = await readPathAsImage(path)
      }
      if (image) addImage(image)
    }
  }, [addImage, text, wsId])

  const ensureSession = React.useCallback(async (): Promise<boolean> => {
    if (!activeChat) return false
    const ok = await cateAgentController.ensureChatSession(wsId, rootPath, activeChat.id)
    if (ok) await refreshSessionChrome()
    return ok
  }, [activeChat, refreshSessionChrome, rootPath, wsId])

  const pickThinking = async (level: CodingThinkingLevel): Promise<void> => {
    setPendingThinking(level)
    if (!activeChat || !(await ensureSession())) return
    await window.electronAPI.agentSetThinkingLevel(panelId, level)
    useCodingStore.getState().setThinkingLevel(panelId, level)
  }

  const togglePlan = async (): Promise<void> => {
    if (!activeChat) {
      setPendingPlan((value) => !value)
      return
    }
    await cateAgentController.togglePlanMode(wsId, rootPath, activeChat.id)
  }

  const manualCompact = async (): Promise<void> => {
    if (!activeChat || !(await ensureSession())) return
    useCodingStore.getState().setCompaction(panelId, { active: true, reason: 'manual' })
    try {
      await window.electronAPI.agentCompact(panelId)
    } finally {
      useCodingStore.getState().setCompaction(panelId, { active: false })
      await refreshSessionChrome()
    }
  }

  const toggleAutoCompaction = async (): Promise<void> => {
    const next = !(session?.autoCompactionEnabled ?? pendingAutoCompaction)
    setPendingAutoCompaction(next)
    if (!activeChat || !(await ensureSession())) return
    await window.electronAPI.agentSetAutoCompaction(panelId, next)
    useCodingStore.getState().setAutoCompactionEnabled(panelId, next)
  }

  // Pick the worktree for the active chat. Carried to a new chat on send() when
  // none is active yet (so a pick made before the first message still counts).
  const pickWorktree = (id: string): void => {
    setTargetId(id)
    if (selectedChatId) setTargetWorktree(selectedChatId, id)
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
      images={images}
      onAddImage={addImage}
      onRemoveImage={(index) => setImages((current) => current.filter((_, i) => i !== index))}
      onPaste={handlePaste}
      onDrop={handleDrop}
      commands={commands}
      onSlashOpen={refreshSessionChrome}
      thinkingLevel={session?.thinkingLevel ?? pendingThinking}
      onPickThinkingLevel={(level) => void pickThinking(level)}
      planModeActive={session
        ? session.extensionStatuses.some((status) => status.key === 'plan-mode')
        : pendingPlan}
      onTogglePlanMode={() => void togglePlan()}
      autoCompactionEnabled={session?.autoCompactionEnabled ?? pendingAutoCompaction}
      onManualCompact={() => void manualCompact()}
      onToggleAutoCompaction={() => void toggleAutoCompaction()}
      compactionActive={session?.compaction.active ?? false}
      stats={session?.stats ?? null}
      models={models}
      modelTitle="Model for the Cate Agent"
      selectedModel={effectiveModel}
      onModelMenuOpen={refreshModels}
      onPickModel={(m) => {
        const next = { provider: m.provider, model: m.model }
        // A pick overrides just the active chat; at the front door (no chat yet)
        // it sets the global default the next new chat will inherit.
        if (activeChat) {
          useChatsStore.getState().setChatModel(rootPath, activeChat.id, next)
          if (cateAgentController.hasChatSession(wsId, activeChat.id)) {
            void window.electronAPI.agentSetModel(panelId, next)
            useCodingStore.getState().setModel(panelId, next)
          }
        } else saveDefaultModel(next)
      }}
      onManageModels={() => useUIStore.getState().openSettings('providers')}
      worktrees={worktrees}
      selectedWorktreeId={targetId}
      onPickWorktree={pickWorktree}
      worktreeMenuHeading="Work in…"
      worktreeTitle="Worktree this task branches off and lands back into"
      rootPath={rootPath}
      onCreateWorktree={onCreateWorktree}
      onCheckoutPr={onCheckoutPr}
    />
  )
}
