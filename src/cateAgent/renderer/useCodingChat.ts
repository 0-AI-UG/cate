// =============================================================================
// useCodingChat — headless per-chat logic for ONE pi coding chat.
//
// Extracted from CodingChatView so the transcript and a separately positioned
// (e.g. floating) composer can be rendered for the SAME chat while sharing one
// useCodingStore slice subscription and one set of handlers. It owns everything
// that depends only on a single `agentKey` and its slice: the composer draft,
// send/steer/stop, model/thinking/compaction/plan controls, image drop/paste,
// fork, the extension UI dialog, and the stats/fork polling effects.
//
// Multi-chat bookkeeping (which chats are open, readiness, the session
// registry, worktree/model MENU DATA) stays in the host and is threaded in via
// params, exactly as CodingChatView received them.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import log from '../../renderer/lib/logger'
import { errorMessage as toErrorMessage } from '../../renderer/lib/errorMessage'
import { useCodingStore } from './codingStore'
import { codingClient } from './codingClient'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { buildFileMentions, type LineRef } from './codingDrop'
import { type ChatComposerProps, type ModelOption } from '../../renderer/chat/ChatComposer'
import type { JoinedWorktree } from '../../renderer/stores/useWorktrees'
import type { PrListItem } from '../../renderer/sidebar/CreateWorktreeForm'
import {
  readFileAsImage,
  readPathAsImage,
  imageMimeForPath,
} from './CateAgentPanelChrome'
import type {
  CodingImageAttachment,
  CateAgentModelRef,
  CodingRpcState,
  CodingSlashCommand,
  CodingThinkingLevel,
} from '../../shared/types'
import { loadDefaultModel, clearModelPrefsForProvider } from './codingModelPrefs'
import { useCodingReadiness, useProvidersLoaded } from '../../renderer/stores/providerReadinessStore'

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

/** Persist pi's assigned session name onto the durable coding chat's title so the
 *  sidebar tab strip and the panel's own chat list agree (the panel reads pi's
 *  live title, the sidebar reads this durable title). Resolves the chat by
 *  agentKey — the same lookup handlePickModel uses — and only writes when pi has a
 *  non-empty name that differs from the stored title, avoiding redundant persists
 *  / update loops. */
export function writeBackSessionTitle(
  rootPath: string,
  agentKey: string,
  sessionName: string | null | undefined,
): void {
  if (typeof sessionName !== 'string' || sessionName.length === 0) return
  const chat = useChatsStore
    .getState()
    .getChatsByMode(rootPath, 'coding')
    .find((c) => c.agentKey === agentKey)
  if (chat && chat.title !== sessionName) {
    useChatsStore.getState().updateCodingChat(rootPath, chat.id, { title: sessionName })
  }
}

export interface UseCodingChatParams {
  /** The pi session this hook drives. Null during the brief window before the
   *  host has resolved an active chat — the empty-state composer shows then. */
  agentKey: string | null
  workspaceId: string
  rootPath: string
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
  commands: CodingSlashCommand[]
  onSlashOpen: () => void
  /** Controlled model-picker open state (the readiness banner opens it). */
  modelPickerOpen: boolean
  onModelPickerOpenChange: (open: boolean) => void
  composerExtras: CodingChatComposerExtras
}

export function useCodingChat({
  agentKey,
  workspaceId,
  rootPath,
  sessionReady,
  readyTick,
  onSessionFile,
  commands,
  onSlashOpen,
  modelPickerOpen,
  onModelPickerOpenChange,
  composerExtras,
}: UseCodingChatParams) {
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
  const slice = useCodingStore((s) => (agentKey ? s.panels[agentKey] : undefined))
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
  const readiness = useCodingReadiness(selectedModel)
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
    const prev = useCodingStore.getState().panels[key]?.draft ?? ''
    const next = typeof value === 'function' ? value(prev) : value
    useCodingStore.getState().setDraft(key, next)
  }, [agentKey])

  const setDraftImages = useCallback(
    (value: CodingImageAttachment[] | ((prev: CodingImageAttachment[]) => CodingImageAttachment[])) => {
      const key = agentKey
      if (!key) return
      const prev = useCodingStore.getState().panels[key]?.draftImages ?? []
      const next = typeof value === 'function' ? value(prev) : value
      useCodingStore.getState().setDraftImages(key, next)
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
    useCodingStore.getState().setModel(agentKey, pick)
  }, [availableModels, selectedModel, agentKey])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    if (!agentKey) return
    // Read the draft straight from the active slice so we never send a stale
    // closure value mid-stream.
    const cur = useCodingStore.getState().panels[agentKey]
    if (!cur?.model) return
    const text = (cur?.draft ?? '').trim()
    const images = (cur?.draftImages ?? []).slice()
    if (!text && images.length === 0) return
    const isSteering = running
    useCodingStore.getState().appendUser(agentKey, isSteering ? `(steer) ${text}` : text)
    setDraft('')
    setDraftImages([])
    try {
      if (isSteering) {
        await codingClient.steer(agentKey, text, images.length > 0 ? images : undefined)
      } else {
        await codingClient.prompt(agentKey, text, images.length > 0 ? images : undefined)
      }
    } catch (err) {
      const msg = toErrorMessage(err)
      useCodingStore.getState().appendSystem(agentKey, `Send failed: ${msg}`, 'error')
    }
  }, [running, agentKey, setDraft, setDraftImages])

  const handleInterrupt = useCallback(async () => {
    if (!agentKey) return
    try { await codingClient.interrupt(agentKey) }
    catch (err) { log.warn('[CateAgentPanel] interrupt failed', err) }
  }, [agentKey])

  const handlePickModel = useCallback(async (m: { provider: string; model: string }) => {
    if (!agentKey) return
    const ref: CateAgentModelRef = { provider: m.provider, model: m.model }
    useCodingStore.getState().setModel(agentKey, ref)
    // Remember the pick on the durable chat so a re-adopting mount resumes with it.
    const entry = useChatsStore.getState().getChatsByMode(rootPath, 'coding').find((c) => c.agentKey === agentKey)
    if (entry) useChatsStore.getState().updateCodingChat(rootPath, entry.id, { model: ref })
    try { await window.electronAPI.agentSetModel(agentKey, ref) }
    catch (err) { log.warn('[CateAgentPanel] setModel failed', err) }
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
    useCodingStore.getState().setModel(agentKey, null)
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
      useCodingStore.getState().setStats(key, statsResp ?? null)
      const st = stateResp as CodingRpcState | null
      if (st) {
        useCodingStore.getState().setThinkingLevel(key, st.thinkingLevel)
        useCodingStore.getState().setAutoCompactionEnabled(key, st.autoCompactionEnabled)
        useCodingStore.getState().setSessionMeta(key, {
          sessionName: st.sessionName,
          sessionFile: st.sessionFile,
        })
        // Pi owns the session name too — mirror it onto the durable coding chat so
        // the sidebar tab strip shows the same title the panel's chat list does.
        writeBackSessionTitle(rootPath, key, st.sessionName)
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
  }, [agentKey, rootPath, onSessionFile])

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
        const local = useCodingStore.getState().panels[key]?.messages ?? []
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
        log.warn('[CateAgentPanel] uiResponse failed', err)
      }
      useCodingStore.getState().resolveUiRequest(agentKey, response.id)
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
      useCodingStore.getState().setCompaction(key, { active: true, reason: 'manual' })
      await window.electronAPI.agentCompact(key)
    } catch (err) {
      const msg = toErrorMessage(err)
      useCodingStore.getState().appendSystem(key, `Compact failed: ${msg}`, 'error')
      useCodingStore.getState().setCompaction(key, { active: false, lastErrorMessage: msg })
    } finally {
      void refreshStatsAndState()
    }
  }, [agentKey, refreshStatsAndState])

  const handleAbortRetry = useCallback(async () => {
    if (!agentKey) return
    try { await window.electronAPI.agentAbortRetry(agentKey) }
    catch (err) { log.warn('[CateAgentPanel] abortRetry failed', err) }
  }, [agentKey])

  const handleToggleAutoCompaction = useCallback(async () => {
    if (!agentKey) return
    const next = !autoCompactionEnabled
    useCodingStore.getState().setAutoCompactionEnabled(agentKey, next)
    try { await window.electronAPI.agentSetAutoCompaction(agentKey, next) }
    catch (err) { log.warn('[CateAgentPanel] setAutoCompaction failed', err) }
  }, [agentKey, autoCompactionEnabled])

  // ---------------------------------------------------------------------------
  // Thinking level
  // ---------------------------------------------------------------------------

  const handlePickThinkingLevel = useCallback(async (level: CodingThinkingLevel) => {
    if (!agentKey) return
    useCodingStore.getState().setThinkingLevel(agentKey, level)
    try { await window.electronAPI.agentSetThinkingLevel(agentKey, level) }
    catch (err) { log.warn('[CateAgentPanel] setThinkingLevel failed', err) }
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
      const local = useCodingStore.getState().panels[key]?.messages ?? []
      const cutIdx = local.findIndex((m) => m.type === 'user' && forkMap[m.id] === entryId)
      if (cutIdx >= 0) {
        useCodingStore.getState().loadMessages(key, local.slice(0, cutIdx + 1))
      }
      setDraft(res.text ?? '')
      void refreshStatsAndState()
    } catch (err) {
      const msg = toErrorMessage(err)
      useCodingStore.getState().appendSystem(key, `Fork failed: ${msg}`, 'error')
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
    try { await codingClient.prompt(agentKey, '/plan') }
    catch (err) { log.warn('[CateAgentPanel] toggle plan mode failed', err) }
  }, [agentKey])

  const handleImplementPlan = useCallback(async () => {
    if (!agentKey) return
    const key = agentKey
    try {
      // The cate-plan-mode extension clears plan mode and starts the implement
      // turn itself (via a custom message), so there's no synthetic user prompt.
      await codingClient.prompt(key, '/apply-plan')
    } catch (err) {
      const msg = toErrorMessage(err)
      useCodingStore.getState().appendSystem(key, `Implement failed: ${msg}`, 'error')
    }
  }, [agentKey])

  const handleRefinePlan = useCallback(async (text: string) => {
    if (!agentKey) return
    const key = agentKey
    try { await codingClient.prompt(key, text) }
    catch (err) {
      const msg = toErrorMessage(err)
      useCodingStore.getState().appendSystem(key, `Refine failed: ${msg}`, 'error')
    }
  }, [agentKey])

  const handleClearAndImplement = useCallback(async () => {
    if (!agentKey) return
    const key = agentKey
    try {
      useCodingStore.getState().setCompaction(key, { active: true, reason: 'manual' })
      await window.electronAPI.agentCompact(key)
      useCodingStore.getState().setCompaction(key, { active: false })
      // 'fresh' tells the extension to restate the full plan: compaction dropped
      // the original plan_complete call from context.
      await codingClient.prompt(key, '/apply-plan fresh')
    } catch (err) {
      const msg = toErrorMessage(err)
      useCodingStore.getState().appendSystem(key, `Clear & implement failed: ${msg}`, 'error')
      useCodingStore.getState().setCompaction(key, { active: false, lastErrorMessage: msg })
    } finally {
      void refreshStatsAndState()
    }
  }, [agentKey, refreshStatsAndState])

  // ---------------------------------------------------------------------------
  // Image drop / paste
  // ---------------------------------------------------------------------------

  const handleAddImage = useCallback((img: CodingImageAttachment) => {
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
  // <FileDropOverlay/> (this root is marked data-filedrop="cateAgent"); the chat
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

  // Editing a past user message drops its text back into the composer and
  // refocuses. Kept here (not inline) so both layouts share one handler.
  const handleEditResend = useCallback((text: string) => {
    setDraft(text)
    textareaRef.current?.focus()
  }, [setDraft])

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

  return {
    // transcript-facing
    messages,
    running,
    retry,
    forkMap,
    onFork: handleFork,
    onEditResend: handleEditResend,
    onImplementPlan: handleImplementPlan,
    onRefinePlan: handleRefinePlan,
    onClearAndImplement: handleClearAndImplement,
    onAbortRetry: handleAbortRetry,
    /** ChatThread scroll-memory key, minus the surface namespace which the
     *  view prepends (`${surface}:${scrollKeyBase}`). */
    scrollKeyBase: agentKey ?? '',
    // composer-facing
    composerProps,
    // banner / state
    readiness,
    composerDisabled,
    composerPlaceholder,
    // whole-panel drop wiring (root marked data-filedrop="cateAgent")
    onDragOver: handlePanelDragOver,
    onDrop: handleDrop,
    // extension UI
    currentUiRequest,
    onUiResponse: handleUiResponse,
    extensionWidgets,
    steeringQueue,
    followUpQueue,
  }
}
