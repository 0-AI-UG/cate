// =============================================================================
// CodingChatView — render + drive ONE pi coding chat.
//
// Extracted verbatim from AgentPanel's per-chat half so the same surface can be
// reused outside the panel (e.g. the sidebar). It owns everything that depends
// only on a single `agentKey` and its useAgentStore slice: the composer draft,
// send/steer/stop, model/thinking/compaction/plan controls, image drop/paste,
// fork, the extension UI dialog, and the stats/fork polling effects.
//
// Multi-chat bookkeeping (which chats are open, readiness, the session
// registry, worktree/model MENU DATA) stays in the host and is threaded in via
// props: the composer's model + worktree menus are host-owned, and the
// model-picker open state is controlled so the host's readiness banner can open
// it. Per-chat readiness (`sessionReady`/`readyTick`) is derived from the host's
// readyByKey ref, so it too arrives as a prop.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatCircle } from '@phosphor-icons/react'
import log from '../../renderer/lib/logger'
import { errorMessage as toErrorMessage } from '../../renderer/lib/errorMessage'
import { useAgentStore } from './agentStore'
import { agentClient } from './agentClient'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { buildFileMentions, type LineRef } from './agentDrop'
import { ChatThread } from './ChatThread'
import { ChatComposer, type ChatComposerProps, type ModelOption } from '../../renderer/chat/ChatComposer'
import type { JoinedWorktree } from '../../renderer/stores/useWorktrees'
import type { PrListItem } from '../../renderer/sidebar/CreateWorktreeForm'
import {
  ExtensionDialog,
  ExtensionWidget,
  QueueBadges,
  readFileAsImage,
  readPathAsImage,
  imageMimeForPath,
} from './AgentPanelChrome'
import type {
  AgentImageAttachment,
  AgentModelRef,
  AgentRpcState,
  AgentSlashCommand,
  AgentThinkingLevel,
} from '../../shared/types'
import { loadDefaultModel, clearModelPrefsForProvider } from './agentModelPrefs'
import { useAgentReadiness, useProvidersLoaded } from '../../renderer/stores/providerReadinessStore'

// Host-owned composer menu data + handlers, threaded through so the shared
// composer carries the same model/worktree controls the host would.
export interface CodingChatComposerExtras {
  availableModels: ModelOption[]
  refreshModels: () => void
  openProviderSettings: () => void
  worktrees: JoinedWorktree[]
  selectedWorktreeId: string | null
  onPickWorktree: (id: string) => void
  onCreateWorktree: (name: string, baseRef?: string) => Promise<string | null>
  onCheckoutPr: (pr: PrListItem) => Promise<string | null>
}

export interface CodingChatViewProps {
  /** The pi session this view renders. Null during the brief window before the
   *  host has resolved an active chat — the empty-state composer shows then,
   *  matching the pre-extraction behaviour. */
  agentKey: string | null
  workspaceId: string
  rootPath: string
  /** Namespaces the ChatThread scroll-memory key so mounting the SAME agentKey
   *  on two surfaces never collides. Defaults to 'panel'. */
  surface?: string
  /** Per-chat pi readiness (host's readyByKey[agentKey]). Polling effects bail
   *  until true. */
  sessionReady: boolean
  /** Host counter bumped whenever any chat's readiness flips — preserves the
   *  polling effects' re-run semantics. */
  readyTick: number
  /** Persist pi's learned on-disk session file onto host bookkeeping + the
   *  durable coding chat. */
  onSessionFile: (agentKey: string, file: string) => void
  /** Slash-command list for this chat (host-fetched) + a request to refresh it
   *  when the "/" popup opens. */
  commands: AgentSlashCommand[]
  onSlashOpen: () => void
  /** Controlled model-picker open state (the readiness banner opens it). */
  modelPickerOpen: boolean
  onModelPickerOpenChange: (open: boolean) => void
  composerExtras: CodingChatComposerExtras
}

export function CodingChatView({
  agentKey,
  workspaceId,
  rootPath,
  surface = 'panel',
  sessionReady,
  readyTick,
  onSessionFile,
  commands,
  onSlashOpen,
  modelPickerOpen,
  onModelPickerOpenChange,
  composerExtras,
}: CodingChatViewProps) {
  const {
    availableModels,
    refreshModels,
    openProviderSettings,
    worktrees,
    selectedWorktreeId,
    onPickWorktree,
    onCreateWorktree,
    onCheckoutPr,
  } = composerExtras

  // Active chat's store slice. All UI-visible state derives from this.
  const slice = useAgentStore((s) => (agentKey ? s.panels[agentKey] : undefined))
  const running = slice?.running ?? false
  const messages = slice?.messages ?? []
  const selectedModel = slice?.model ?? null
  const stats = slice?.stats ?? null
  const thinkingLevel = slice?.thinkingLevel ?? null
  const autoCompactionEnabled = slice?.autoCompactionEnabled ?? true
  const compaction = slice?.compaction ?? { active: false }
  const retry = slice?.retry ?? { active: false }
  const steeringQueue = slice?.steeringQueue ?? []
  const followUpQueue = slice?.followUpQueue ?? []
  const extensionStatuses = slice?.extensionStatuses ?? []
  const extensionWidgets = slice?.extensionWidgets ?? []
  // Composer draft lives in the active chat's slice so switching chats keeps
  // each chat's own in-progress message + image attachments.
  const draft = slice?.draft ?? ''
  const draftImages = slice?.draftImages ?? []

  const uiRequests = slice?.uiRequests ?? []
  const currentUiRequest = uiRequests[0]

  // Provider connection + health come from the shared readiness store (one source
  // of truth across the app), passed the model this chat has selected so it can
  // live-verify that exact provider/model.
  const readiness = useAgentReadiness(selectedModel)
  /** False until the first authStatus() round-trip — gates the stale-model
   *  reset below so an empty initial status list never wipes a valid pick. */
  const authLoaded = useProvidersLoaded()

  /** Map of local user-message id → pi entryId, populated from getForkMessages
   *  so the hover "fork from here" button can find an entryId for messages we
   *  appended before pi assigned one. */
  const [forkMap, setForkMap] = useState<Record<string, string>>({})

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Draft setters that target the active chat's slice. Accept the same value /
  // updater-function forms as a React state setter so call sites read unchanged.
  const setDraft = useCallback((value: string | ((prev: string) => string)) => {
    const key = agentKey
    if (!key) return
    const prev = useAgentStore.getState().panels[key]?.draft ?? ''
    const next = typeof value === 'function' ? value(prev) : value
    useAgentStore.getState().setDraft(key, next)
  }, [agentKey])

  const setDraftImages = useCallback(
    (value: AgentImageAttachment[] | ((prev: AgentImageAttachment[]) => AgentImageAttachment[])) => {
      const key = agentKey
      if (!key) return
      const prev = useAgentStore.getState().panels[key]?.draftImages ?? []
      const next = typeof value === 'function' ? value(prev) : value
      useAgentStore.getState().setDraftImages(key, next)
    },
    [agentKey],
  )

  // Default-pick once auth resolves — applies to the active chat only. Other
  // open chats keep whichever model they were created with; the user can swap
  // each independently. Prefers the configured default; otherwise falls back
  // to the first available model.
  useEffect(() => {
    if (!agentKey) return
    if (selectedModel) return
    if (availableModels.length === 0) return
    const def = loadDefaultModel()
    const pick = def && availableModels.some((m) => m.provider === def.provider && m.model === def.model)
      ? def
      : { provider: availableModels[0].provider, model: availableModels[0].model }
    useAgentStore.getState().setModel(agentKey, pick)
  }, [availableModels, selectedModel, agentKey])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    if (!agentKey) return
    // Read the draft straight from the active slice so we never send a stale
    // closure value mid-stream.
    const cur = useAgentStore.getState().panels[agentKey]
    if (!cur?.model) return
    const text = (cur?.draft ?? '').trim()
    const images = (cur?.draftImages ?? []).slice()
    if (!text && images.length === 0) return
    const isSteering = running
    useAgentStore.getState().appendUser(agentKey, isSteering ? `(steer) ${text}` : text)
    setDraft('')
    setDraftImages([])
    try {
      if (isSteering) {
        await agentClient.steer(agentKey, text, images.length > 0 ? images : undefined)
      } else {
        await agentClient.prompt(agentKey, text, images.length > 0 ? images : undefined)
      }
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(agentKey, `Send failed: ${msg}`, 'error')
    }
  }, [running, agentKey, setDraft, setDraftImages])

  const handleInterrupt = useCallback(async () => {
    if (!agentKey) return
    try { await agentClient.interrupt(agentKey) }
    catch (err) { log.warn('[AgentPanel] interrupt failed', err) }
  }, [agentKey])

  const handlePickModel = useCallback(async (m: { provider: string; model: string }) => {
    if (!agentKey) return
    const ref: AgentModelRef = { provider: m.provider, model: m.model }
    useAgentStore.getState().setModel(agentKey, ref)
    // Remember the pick on the durable chat so a re-adopting mount resumes with it.
    const entry = useChatsStore.getState().getChatsByMode(rootPath, 'coding').find((c) => c.agentKey === agentKey)
    if (entry) useChatsStore.getState().updateCodingChat(rootPath, entry.id, { model: ref })
    try { await window.electronAPI.agentSetModel(agentKey, ref) }
    catch (err) { log.warn('[AgentPanel] setModel failed', err) }
  }, [agentKey, rootPath])

  // ---------------------------------------------------------------------------
  // Stale-model reset
  //
  // A model remembered from a provider the user has since cleared (saved
  // default, or a resumed session's lastModel) should reset, not prompt a
  // reconnect. Once real auth state is in, drop the stale pick — the auto-pick
  // effect above then selects from whatever providers remain, or the "no
  // model" hint shows when none do. `noModel`/`noProvider` with a model set both
  // mean the selected provider is no longer connected.
  // ---------------------------------------------------------------------------

  const selectedProviderMissing =
    authLoaded && !!selectedModel && (readiness.kind === 'noModel' || readiness.kind === 'noProvider')
  useEffect(() => {
    if (!agentKey || !selectedModel || !selectedProviderMissing) return
    useAgentStore.getState().setModel(agentKey, null)
    clearModelPrefsForProvider(selectedModel.provider)
  }, [agentKey, selectedModel, selectedProviderMissing])

  // The composer is usable only once we have a connected, working provider AND a
  // model. Anything else (no provider, no model, expired sign-in, failed probe)
  // disables it; the banner below explains which, and the placeholder mirrors it.
  const composerDisabled = readiness.kind !== 'ok'
  const composerPlaceholder =
    readiness.kind === 'ok' || readiness.kind === 'loading' ? undefined : readiness.message

  // ---------------------------------------------------------------------------
  // Stats polling — refresh after every assistant turn (cheap; the call just
  // reads pi's already-computed counters). We pull state too so the renderer
  // mirrors pi's authoritative thinking level / auto-flags / session name.
  // ---------------------------------------------------------------------------

  const refreshStatsAndState = useCallback(async () => {
    if (!agentKey) return
    const key = agentKey
    try {
      const [statsResp, stateResp] = await Promise.all([
        window.electronAPI.agentGetSessionStats(key),
        window.electronAPI.agentGetState(key),
      ])
      useAgentStore.getState().setStats(key, statsResp ?? null)
      const st = stateResp as AgentRpcState | null
      if (st) {
        useAgentStore.getState().setThinkingLevel(key, st.thinkingLevel)
        useAgentStore.getState().setAutoCompactionEnabled(key, st.autoCompactionEnabled)
        useAgentStore.getState().setSessionMeta(key, {
          sessionName: st.sessionName,
          sessionFile: st.sessionFile,
        })
        // Pi owns the session file path — keep our openChats entry in sync so
        // the sidebar highlights the right row and so reopening from the
        // sidebar reuses this live chat rather than spawning a duplicate.
        if (st.sessionFile) {
          onSessionFile(key, st.sessionFile)
        }
      }
    } catch {
      /* RPC not ready yet — silently retry on the next tick. */
    }
  }, [agentKey, onSessionFile])

  // Pull stats on every transition out of running (turn finished) and once at mount.
  useEffect(() => {
    if (running || !sessionReady) return
    void refreshStatsAndState()
  }, [running, sessionReady, refreshStatsAndState, readyTick])

  // ---------------------------------------------------------------------------
  // Fork map refresh — keep a local mapping of pi entryIds so the hover "fork
  // from here" gesture has something to point at. We only refresh after a turn
  // (when message_count changes) to keep traffic down.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (running || !sessionReady) return
    if (!agentKey) return
    const key = agentKey
    let cancelled = false
    void (async () => {
      try {
        const forks = await window.electronAPI.agentGetForkMessages(key)
        if (cancelled) return
        // Match in order — pi returns fork-eligible user messages oldest first,
        // and our local user message list is the same order.
        const local = useAgentStore.getState().panels[key]?.messages ?? []
        const localUsers = local.filter((m) => m.type === 'user')
        const next: Record<string, string> = {}
        for (let i = 0; i < Math.min(localUsers.length, forks.length); i++) {
          next[localUsers[i].id] = forks[i].entryId
        }
        setForkMap(next)
      } catch {
        /* ignore — pi may not be ready yet */
      }
    })()
    return () => { cancelled = true }
  }, [running, sessionReady, messages.length, agentKey, readyTick])

  // ---------------------------------------------------------------------------
  // Extension UI dialog response
  // ---------------------------------------------------------------------------

  const handleUiResponse = useCallback(
    (response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => {
      if (!agentKey) return
      try {
        window.electronAPI.agentUiResponse(agentKey, response)
      } catch (err) {
        log.warn('[AgentPanel] uiResponse failed', err)
      }
      useAgentStore.getState().resolveUiRequest(agentKey, response.id)
    },
    [agentKey],
  )

  // ---------------------------------------------------------------------------
  // Compaction / retry controls
  // ---------------------------------------------------------------------------

  const handleManualCompact = useCallback(async () => {
    if (!agentKey) return
    const key = agentKey
    try {
      useAgentStore.getState().setCompaction(key, { active: true, reason: 'manual' })
      await window.electronAPI.agentCompact(key)
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Compact failed: ${msg}`, 'error')
      useAgentStore.getState().setCompaction(key, { active: false, lastErrorMessage: msg })
    } finally {
      void refreshStatsAndState()
    }
  }, [agentKey, refreshStatsAndState])

  const handleAbortRetry = useCallback(async () => {
    if (!agentKey) return
    try { await window.electronAPI.agentAbortRetry(agentKey) }
    catch (err) { log.warn('[AgentPanel] abortRetry failed', err) }
  }, [agentKey])

  const handleToggleAutoCompaction = useCallback(async () => {
    if (!agentKey) return
    const next = !autoCompactionEnabled
    useAgentStore.getState().setAutoCompactionEnabled(agentKey, next)
    try { await window.electronAPI.agentSetAutoCompaction(agentKey, next) }
    catch (err) { log.warn('[AgentPanel] setAutoCompaction failed', err) }
  }, [agentKey, autoCompactionEnabled])

  // ---------------------------------------------------------------------------
  // Thinking level
  // ---------------------------------------------------------------------------

  const handlePickThinkingLevel = useCallback(async (level: AgentThinkingLevel) => {
    if (!agentKey) return
    useAgentStore.getState().setThinkingLevel(agentKey, level)
    try { await window.electronAPI.agentSetThinkingLevel(agentKey, level) }
    catch (err) { log.warn('[AgentPanel] setThinkingLevel failed', err) }
  }, [agentKey])

  // ---------------------------------------------------------------------------
  // Fork
  // ---------------------------------------------------------------------------

  const handleFork = useCallback(async (entryId: string) => {
    if (!agentKey) return
    const key = agentKey
    try {
      const res = await window.electronAPI.agentFork(key, entryId)
      if (res.cancelled) return
      // After forking, pi has replaced its active branch with a new session
      // truncated at the chosen message. Truncate our local UI to match.
      const local = useAgentStore.getState().panels[key]?.messages ?? []
      const cutIdx = local.findIndex((m) => m.type === 'user' && forkMap[m.id] === entryId)
      if (cutIdx >= 0) {
        useAgentStore.getState().loadMessages(key, local.slice(0, cutIdx + 1))
      }
      setDraft(res.text ?? '')
      void refreshStatsAndState()
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Fork failed: ${msg}`, 'error')
    }
  }, [agentKey, forkMap, refreshStatsAndState, setDraft])

  // ---------------------------------------------------------------------------
  // Plan mode (cate-plan-mode extension)
  // ---------------------------------------------------------------------------

  const planModeActive = useMemo(
    () => extensionStatuses.some((s) => s.key === 'plan-mode'),
    [extensionStatuses],
  )

  const handleTogglePlanMode = useCallback(async () => {
    if (!agentKey) return
    try { await agentClient.prompt(agentKey, '/plan') }
    catch (err) { log.warn('[AgentPanel] toggle plan mode failed', err) }
  }, [agentKey])

  const handleImplementPlan = useCallback(async () => {
    if (!agentKey) return
    const key = agentKey
    try {
      // The cate-plan-mode extension clears plan mode and starts the implement
      // turn itself (via a custom message), so there's no synthetic user prompt.
      await agentClient.prompt(key, '/apply-plan')
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Implement failed: ${msg}`, 'error')
    }
  }, [agentKey])

  const handleRefinePlan = useCallback(async (text: string) => {
    if (!agentKey) return
    const key = agentKey
    try { await agentClient.prompt(key, text) }
    catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Refine failed: ${msg}`, 'error')
    }
  }, [agentKey])

  const handleClearAndImplement = useCallback(async () => {
    if (!agentKey) return
    const key = agentKey
    try {
      useAgentStore.getState().setCompaction(key, { active: true, reason: 'manual' })
      await window.electronAPI.agentCompact(key)
      useAgentStore.getState().setCompaction(key, { active: false })
      // 'fresh' tells the extension to restate the full plan: compaction dropped
      // the original plan_complete call from context.
      await agentClient.prompt(key, '/apply-plan fresh')
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Clear & implement failed: ${msg}`, 'error')
      useAgentStore.getState().setCompaction(key, { active: false, lastErrorMessage: msg })
    } finally {
      void refreshStatsAndState()
    }
  }, [agentKey, refreshStatsAndState])

  // ---------------------------------------------------------------------------
  // Image drop / paste
  // ---------------------------------------------------------------------------

  const handleAddImage = useCallback((img: AgentImageAttachment) => {
    setDraftImages((prev) => [...prev, img])
  }, [setDraftImages])

  const handleRemoveImage = useCallback((idx: number) => {
    setDraftImages((prev) => prev.filter((_, i) => i !== idx))
  }, [setDraftImages])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    let any = false
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (!file) continue
        const img = await readFileAsImage(file)
        if (img) { handleAddImage(img); any = true }
      }
    }
    if (any) e.preventDefault()
  }, [handleAddImage])

  // Whole-panel file drop. The drop indicator is rendered globally by
  // <FileDropOverlay/> (this root is marked data-filedrop="agent"); the chat
  // input also forwards drops here and handleDrop stops propagation so a drop
  // never fires twice.
  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    const t = e.dataTransfer?.types
    if (t && (t.includes('application/cate-files') || t.includes('application/cate-file') || t.includes('Files'))) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    // Files dragged from Cate's own Explorer come through as a JSON payload of
    // absolute paths under `application/cate-files`. Image files are attached as
    // image inputs; everything else is inserted into the draft as @-mentions.
    const cateRaw = e.dataTransfer?.getData('application/cate-files')
    if (cateRaw) {
      e.preventDefault()
      e.stopPropagation()
      try {
        const paths = JSON.parse(cateRaw) as string[]
        if (Array.isArray(paths) && paths.length > 0) {
          const imagePaths = paths.filter((p) => imageMimeForPath(p))
          const otherPaths = paths.filter((p) => !imageMimeForPath(p))
          // Attach images by reading their bytes through the workspace's
          // runtime (works for remote workspaces too).
          for (const p of imagePaths) {
            const img = await readPathAsImage(p, workspaceId)
            if (img) handleAddImage(img)
          }
          if (otherPaths.length > 0) {
            // A search-line drag carries the line number — mention it as
            // @path:line so the agent gets the exact location.
            let lineRef: LineRef | null = null
            const lineRaw = e.dataTransfer.getData('application/cate-file-line')
            if (lineRaw) {
              try { lineRef = JSON.parse(lineRaw) } catch { /* ignore */ }
            }
            const mentions = buildFileMentions(otherPaths, lineRef)
            setDraft((prev) => (prev ? `${prev}${prev.endsWith(' ') ? '' : ' '}${mentions} ` : `${mentions} `))
          }
        }
      } catch { /* ignore malformed payload */ }
      return
    }
    // External OS file drop. Read image bytes directly off the dropped File
    // (no fs permission needed); fall back to its real path for cases where the
    // File has no readable type but a known image extension.
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    e.stopPropagation()
    for (const file of Array.from(e.dataTransfer.files)) {
      let img = await readFileAsImage(file)
      if (!img) {
        const filePath = window.electronAPI?.getPathForFile?.(file)
        if (filePath && imageMimeForPath(filePath)) img = await readPathAsImage(filePath)
      }
      if (img) handleAddImage(img)
    }
  }, [handleAddImage, setDraft, workspaceId])

  // ---------------------------------------------------------------------------
  // Composer
  //
  // Both call sites (empty state and below-thread) render the same shared
  // composer with the same props; only the placeholder differs.
  // ---------------------------------------------------------------------------

  const composerProps: Omit<ChatComposerProps, 'placeholder'> = {
    draft,
    onChange: setDraft,
    onSubmit: handleSend,
    onStop: handleInterrupt,
    disabled: composerDisabled,
    running,
    textareaRef,
    commands,
    images: draftImages,
    onAddImage: handleAddImage,
    onRemoveImage: handleRemoveImage,
    onPaste: handlePaste,
    onDrop: handleDrop,
    stats,
    thinkingLevel,
    onPickThinkingLevel: handlePickThinkingLevel,
    autoCompactionEnabled,
    onManualCompact: handleManualCompact,
    onToggleAutoCompaction: handleToggleAutoCompaction,
    compactionActive: compaction.active,
    planModeActive,
    onTogglePlanMode: handleTogglePlanMode,
    onSlashOpen,
    // Model is per-chat: the pick targets the active chat's slice only and
    // never writes the persisted default.
    models: availableModels,
    selectedModel,
    onPickModel: handlePickModel,
    onManageModels: openProviderSettings,
    onModelMenuOpen: () => { void refreshModels() },
    modelMenuOpen: modelPickerOpen,
    onModelMenuOpenChange: onModelPickerOpenChange,
    // Worktree = this panel's working directory.
    worktrees,
    selectedWorktreeId,
    onPickWorktree: (id) => { onPickWorktree(id) },
    rootPath,
    worktreeMenuHeading: 'Work in…',
    worktreeTitle:
      'The agent’s working directory. Switching restarts its chats in the new checkout.',
    onCreateWorktree,
    onCheckoutPr,
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="relative flex-1 flex flex-col min-h-0"
      data-filedrop="agent"
      onDragOver={handlePanelDragOver}
      onDrop={handleDrop}
    >
      {readiness.kind !== 'ok' && readiness.kind !== 'loading' ? (
        <div className="px-3 py-2 bg-agent/10 border-b border-agent/30 flex items-center gap-2 text-[12px] text-primary">
          <span className="flex-1 truncate" title={readiness.error}>
            {readiness.message}
          </span>
          {/* A missing model is fixed at the composer's model pill, not in
              provider settings — send the user to the control that fixes
              the thing the banner is complaining about. */}
          {readiness.kind === 'noModel' ? (
            <button
              onClick={() => { void refreshModels(); onModelPickerOpenChange(true) }}
              className="px-2 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium shrink-0"
            >
              Pick model
            </button>
          ) : (
            <button
              onClick={openProviderSettings}
              className="px-2 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium shrink-0"
            >
              {readiness.kind === 'needsReauth' ? 'Reconnect' : 'Set up provider'}
            </button>
          )}
        </div>
      ) : null}

      {/* Retry status is now shown inline in the chat thread */}
      <ExtensionWidget widgets={extensionWidgets} placement="aboveEditor" />
      <QueueBadges steering={steeringQueue} followUp={followUpQueue} />

      {messages.length === 0 ? (
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-8 min-h-0">
          <div className="w-full max-w-[520px] flex flex-col items-center">
            <div className="w-12 h-12 rounded-2xl bg-agent/15 flex items-center justify-center mb-4">
              <ChatCircle size={22} className="text-agent-light" />
            </div>
            <div className="text-[16px] font-medium text-primary mb-3 text-center">
              What should we work on?
            </div>
            <div className="w-full">
              <ChatComposer
                {...composerProps}
                placeholder={composerPlaceholder ?? 'Ask the agent anything about this workspace…'}
              />
            </div>
          </div>
        </div>
      ) : (
        <>
          <ChatThread
            scrollKey={`${surface}:${agentKey ?? ''}`}
            messages={messages}
            running={running}
            forkMap={forkMap}
            onFork={handleFork}
            onEditResend={(text) => {
              setDraft(text)
              textareaRef.current?.focus()
            }}
            onImplementPlan={handleImplementPlan}
            onRefinePlan={handleRefinePlan}
            onClearAndImplement={handleClearAndImplement}
            retry={retry}
            onAbortRetry={handleAbortRetry}
          />
          <ExtensionWidget widgets={extensionWidgets} placement="belowEditor" />
          {currentUiRequest && (
            <div className="px-3 pt-2">
              <ExtensionDialog request={currentUiRequest} onRespond={handleUiResponse} />
            </div>
          )}
          <div className="px-3 py-2 shrink-0">
            <ChatComposer {...composerProps} placeholder={composerPlaceholder} />
          </div>
        </>
      )}
    </div>
  )
}
