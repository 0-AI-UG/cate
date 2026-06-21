// =============================================================================
// AgentPanel — Pi coding-agent chat panel.
//
// Layout (Codex-style):
//   ┌──────────────┬───────────────────────────────────────────────┐
//   │  Sidebar     │  Header  (model picker · stop)                │
//   │  • New chat  │ ───────────────────────────────────────────── │
//   │  • Recent    │           Welcome / thread                    │
//   └──────────────┴───────────────────────────────────────────────┘
//
// The sidebar is collapsible (hamburger in header). Per-agent settings
// (custom agents/prompts/extensions) were removed — the agent is opinionated;
// provider sign-in lives in the main Cate Settings → Providers.
//
// Chats are pi's own session files on disk (<cwd>/.cate/pi-agent/sessions/<cwd>/*.jsonl).
// The sidebar reads them via AGENT_LIST_SESSIONS; opening a row resumes that
// session by spawning pi with `--session <path>`. New chat = dispose + create
// without a session file, then pick up pi's freshly-written file from getState.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CaretDown,
  Sidebar as SidebarIcon,
  Gear,
} from '@phosphor-icons/react'
import { CateLogo } from '../../renderer/ui/CateLogo'
import log from '../../renderer/lib/logger'
import { errorMessage as toErrorMessage } from '../../renderer/lib/errorMessage'
import type { PanelProps } from '../../renderer/panels/types'
import { useAppStore } from '../../renderer/stores/appStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { useAgentStore } from './agentStore'
import {
  getAgentPanelSession,
  saveAgentPanelSession,
  disposeAgentChats,
  type OpenChat,
} from './agentSessionRegistry'
import { buildFileMentions, type LineRef } from './agentDrop'
import { ChatThread } from './ChatThread'
import { AgentSidebar } from './AgentSidebar'
import { ChatInput } from './AgentChatInput'
import { ModelPickerDropdown } from './ModelPicker'
import {
  ExtensionDialog,
  ExtensionStatusBar,
  ExtensionWidget,
  QueueBadges,
  readFileAsImage,
  readPathAsImage,
  imageMimeForPath,
} from './AgentPanelChrome'
import { SettingsView } from './AgentSettingsView'
import type {
  AgentImageAttachment,
  AgentModelRef,
  AgentRpcState,
  AgentSessionListEntry,
  AgentSlashCommand,
  AgentThinkingLevel,
  AuthProviderStatus,
} from '../../shared/types'
import type { AgentMessage as StoreMessage } from './agentStore'
import { loadDefaultModel, clearModelPrefsForProvider } from './agentModelPrefs'

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function AgentPanel({ panelId, workspaceId }: PanelProps) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  // If this panel is tagged with a worktree, prefer its path so pi spawns
  // inside that parallel checkout instead of the workspace's primary root.
  const panelState = workspace?.panels[panelId]
  const taggedWorktree = panelState?.worktreeId
    ? workspace?.worktrees?.find((w) => w.id === panelState.worktreeId)
    : undefined
  const cwd = taggedWorktree?.path ?? workspace?.rootPath ?? ''

  // ---------------------------------------------------------------------------
  // Multi-chat session bookkeeping.
  //
  // One AgentPanel hosts N concurrent pi chat sessions. Each chat has its own
  // pi process (keyed by `agentKey`) and its own slice in useAgentStore. The
  // UI renders the active chat's slice; background chats keep streaming events
  // into their slices so switching back resumes mid-turn with no state loss.
  //
  // The React `panelId` prop is the dock-panel identity — used only to
  // namespace generated agent keys (so distinct AgentPanel instances never
  // collide) and as the mount/unmount anchor for cleanup.
  // ---------------------------------------------------------------------------
  const [openChats, setOpenChats] = useState<OpenChat[]>([])
  const [activeAgentKey, setActiveAgentKey] = useState<string | null>(null)
  /** Ref mirror — the unmount cleanup needs the latest openChats list to
   *  dispose every pi process we ever spawned. */
  const openChatsRef = useRef<OpenChat[]>([])
  openChatsRef.current = openChats
  /** Per-chat pi-readiness flag. Polling effects bail until true so we don't
   *  bombard a not-yet-started pi with RPCs. */
  const readyByKey = useRef<Record<string, boolean>>({})
  /** Tick incremented when readyByKey changes so dependent effects re-run. */
  const [readyTick, setReadyTick] = useState(0)
  /** Generation counter — bumped on every chat-open/new operation. In-flight
   *  startup work checks this after each await and bails if superseded. */
  const openGenRef = useRef(0)

  const activeChat =
    openChats.find((c) => c.agentKey === activeAgentKey) ?? null
  const currentSessionFile = activeChat?.sessionFile ?? null
  const sessionReady = activeAgentKey
    ? !!readyByKey.current[activeAgentKey]
    : false

  // Active chat's store slice. All UI-visible state derives from this.
  const slice = useAgentStore((s) =>
    activeAgentKey ? s.panels[activeAgentKey] : undefined,
  )
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

  const [providerStatuses, setProviderStatuses] = useState<AuthProviderStatus[]>([])
  /** False until the first authStatus() round-trip — gates the stale-model
   *  reset below so an empty initial status list never wipes a valid pick. */
  const [authLoaded, setAuthLoaded] = useState(false)
  const [availableModels, setAvailableModels] = useState<
    Array<{ provider: string; model: string; label?: string }>
  >([])
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  /** Pi-session entries on disk for this workspace's cwd. Sidebar source of
   *  truth — no localStorage shadow list. */
  const [chats, setChats] = useState<AgentSessionListEntry[]>([])
  const [chatSearch, setChatSearch] = useState('')
  const [commands, setCommands] = useState<AgentSlashCommand[]>([])
  /** Map of local user-message id → pi entryId, populated from getForkMessages
   *  so the hover "fork from here" button can find an entryId for messages we
   *  appended before pi assigned one. */
  const [forkMap, setForkMap] = useState<Record<string, string>>({})

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** Mint a fresh IPC session key for a new chat, namespaced by the React
   *  panel id so distinct AgentPanel instances never collide. */
  const newAgentKey = useCallback((): string => {
    const rnd =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    return `agent-${panelId}-${rnd}`
  }, [panelId])

  const markReady = useCallback((key: string, ready: boolean) => {
    readyByKey.current[key] = ready
    setReadyTick((n) => n + 1)
  }, [])

  const updateChatSessionFile = useCallback((key: string, file: string) => {
    setOpenChats((prev) => {
      const idx = prev.findIndex((c) => c.agentKey === key)
      if (idx < 0) return prev
      if (prev[idx].sessionFile === file) return prev
      const next = prev.slice()
      next[idx] = { ...next[idx], sessionFile: file }
      return next
    })
  }, [])

  // Draft setters that target the active chat's slice. Accept the same value /
  // updater-function forms as a React state setter so call sites read unchanged.
  const setDraft = useCallback((value: string | ((prev: string) => string)) => {
    const key = activeAgentKey
    if (!key) return
    const prev = useAgentStore.getState().panels[key]?.draft ?? ''
    const next = typeof value === 'function' ? value(prev) : value
    useAgentStore.getState().setDraft(key, next)
  }, [activeAgentKey])

  const setDraftImages = useCallback(
    (value: AgentImageAttachment[] | ((prev: AgentImageAttachment[]) => AgentImageAttachment[])) => {
      const key = activeAgentKey
      if (!key) return
      const prev = useAgentStore.getState().panels[key]?.draftImages ?? []
      const next = typeof value === 'function' ? value(prev) : value
      useAgentStore.getState().setDraftImages(key, next)
    },
    [activeAgentKey],
  )

  // ---------------------------------------------------------------------------
  // Auth/provider refresh
  // ---------------------------------------------------------------------------

  const refreshAuth = useCallback(async () => {
    try {
      const statuses = await window.electronAPI.authStatus()
      setProviderStatuses(statuses)
      setAuthLoaded(true)
    } catch (err) {
      log.warn('[AgentPanel] refreshAuth failed', err)
    }
  }, [])

  useEffect(() => { refreshAuth() }, [refreshAuth])

  const refreshModels = useCallback(async () => {
    try {
      const models = await window.electronAPI.agentListModels()
      setAvailableModels(models.map((m) => ({ provider: m.provider, model: m.id, label: m.label })))
    } catch (err) {
      log.warn('[AgentPanel] listModels failed', err)
    }
  }, [])

  useEffect(() => { void refreshModels() }, [refreshModels])

  // Credentials can change anywhere (main Settings → Providers, another window,
  // a token refresh). The main process broadcasts AUTH_CHANGED once the shared
  // auth.json is mirrored into live sessions; re-fetch provider status + the
  // model list so the picker and auto-pick reflect newly-connected providers
  // without waiting for the next turn.
  useEffect(() => {
    if (!window.electronAPI?.onAuthChanged) return
    const unsub = window.electronAPI.onAuthChanged(() => {
      void refreshAuth()
      void refreshModels()
    })
    return unsub
  }, [refreshAuth, refreshModels])

  // ---------------------------------------------------------------------------
  // Chat list — sourced directly from pi's on-disk sessions for this cwd.
  // ---------------------------------------------------------------------------

  const refreshChats = useCallback(async () => {
    if (!cwd) { setChats([]); return }
    try {
      const list = await window.electronAPI.agentListSessions(cwd)
      setChats(list)
    } catch (err) {
      log.warn('[AgentPanel] listSessions failed', err)
    }
  }, [cwd])

  useEffect(() => { void refreshChats() }, [refreshChats])

  // Re-list after every turn — pi may have written/renamed a session file.
  useEffect(() => {
    if (running) return
    void refreshChats()
  }, [running, refreshChats])

  // Sync agent running state → statusStore so the workspace overview shows
  // shimmer (running) and await indicator (waitingForInput) for this panel.
  useEffect(() => {
    const state: import('../../shared/types').AgentState = running
      ? 'running'
      : 'waitingForInput'
    useStatusStore.getState().setAgentState(workspaceId, panelId, state, 'Pi')
    return () => {
      useStatusStore.getState().setAgentState(workspaceId, panelId, 'notRunning', null)
    }
  }, [running, workspaceId, panelId])

  // ---------------------------------------------------------------------------
  // Create / dispose the underlying pi agent. Re-runs when chat or model
  // changes so the main-process session matches the visible chat.
  // ---------------------------------------------------------------------------

  const refreshCommands = useCallback(async (key: string) => {
    if (!key) return
    try {
      const cmds = await window.electronAPI.agentGetCommands(key)
      setCommands(cmds)
    } catch (err) {
      log.warn('[AgentPanel] getCommands failed', err)
    }
  }, [])

  const createAgent = useCallback(async (
    key: string,
    model: AgentModelRef | null,
    sessionFile?: string,
  ) => {
    markReady(key, false)
    try {
      const res = await window.electronAPI.agentCreate({
        panelId: key,
        workspaceId,
        cwd,
        model: model ?? undefined,
        sessionFile,
      })
      if (!res.ok) {
        markReady(key, false)
        useAgentStore.getState().appendSystem(key, `Failed to start agent: ${res.error}`)
        return
      }
      markReady(key, true)
      // Pi's commands (skills + prompts + extensions) are only available once
      // the RPC session is up. Fetch after a successful create. The model list
      // is session-independent (read from auth.json), so it's fetched on mount
      // via the effect below rather than here.
      void refreshCommands(key)
    } catch (err) {
      // Transient errors during rapid chat-switching are expected. Genuine
      // startup failures surface via the `if (!res.ok)` branch above.
      markReady(key, false)
      log.warn('[AgentPanel] createAgent failed', err)
    }
  }, [workspaceId, cwd, refreshCommands, markReady])

  // Open the most-recent on-disk session for the current cwd as the panel's sole
  // chat (or a fresh chat if the checkout has none). Shared by the mount effect
  // and the worktree-switch reinit below; both pass a `signal` so they can abort
  // the in-flight startup if the panel unmounts or the cwd changes again.
  const openInitialChat = useCallback(async (signal: { cancelled: boolean }) => {
    const myGen = ++openGenRef.current
    let resume: AgentSessionListEntry | null = null
    try {
      if (cwd) {
        const list = await window.electronAPI.agentListSessions(cwd)
        if (signal.cancelled || myGen !== openGenRef.current) return
        if (list.length > 0) resume = list[0]
      }
    } catch { /* ignore — list failures fall through to fresh session */ }

    if (signal.cancelled || myGen !== openGenRef.current) return
    const key = newAgentKey()
    useAgentStore.getState().init(key)
    // Resume: prefer the chat's last-used model recorded in the session.
    // Fresh chat: prefer the user-configured default, else fall through to
    // the availableModels effect below.
    const initialModel: AgentModelRef | null = resume?.lastModel
      ? { provider: resume.lastModel.provider, model: resume.lastModel.model }
      : loadDefaultModel()
    if (initialModel) useAgentStore.getState().setModel(key, initialModel)

    if (resume) {
      try {
        const transcript = await window.electronAPI.agentLoadSessionMessages(resume.path)
        if (signal.cancelled || myGen !== openGenRef.current) return
        useAgentStore.getState().loadMessages(key, transcript as StoreMessage[])
      } catch (err) { log.warn('[AgentPanel] load transcript failed', err) }
    }
    if (signal.cancelled || myGen !== openGenRef.current) return
    // Set state BEFORE creating pi so this key is recorded in openChats (and
    // mirrored to the session registry) before any teardown could run.
    setOpenChats([{ agentKey: key, sessionFile: resume?.path ?? null }])
    setActiveAgentKey(key)
    await createAgent(key, initialModel, resume?.path)
  }, [cwd, newAgentKey, createAgent])

  // Mount: re-adopt this panel's live chats if a prior mount left them in the
  // session registry (e.g. the panel was dragged between a canvas node and a
  // dock zone, which unmounts it here and remounts it in another subtree).
  // Otherwise open the most-recent on-disk session as the initial chat.
  //
  // Unmount is deliberately NOT a teardown: the pi processes + store slices are
  // keyed by agentKey and must survive a remount. Genuine teardown runs from
  // the appStore close paths via disposeAgentPanel().
  useEffect(() => {
    const saved = getAgentPanelSession(panelId)
    if (saved && saved.openChats.length > 0) {
      // Pi processes for these chats are still running and their store slices
      // intact — just restore the bookkeeping. No resume-from-disk, no respawn.
      readyByKey.current = { ...saved.readyByKey }
      setOpenChats(saved.openChats)
      setActiveAgentKey(saved.activeAgentKey)
      setReadyTick((n) => n + 1)
      // Slash commands live in component state, not the registry, so a remount
      // starts with an empty list. The pi session is still alive — re-fetch its
      // commands for the active chat so "/" works without a reopen.
      if (saved.activeAgentKey) void refreshCommands(saved.activeAgentKey)
      return
    }

    const signal = { cancelled: false }
    void openInitialChat(signal)

    return () => {
      // Cancel any in-flight startup; do NOT dispose pi/store here — the panel
      // may just be moving between canvas and dock. Teardown is centralized in
      // disposeAgentPanel(), called from the appStore close paths.
      signal.cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId])

  // Worktree switch: pi's cwd is fixed at spawn and its sessions are cwd-scoped
  // on disk, so re-tagging the panel's worktree (via the WorktreePill) isn't
  // enough — the live chats still run in the old checkout. When the derived cwd
  // changes under a live mount, dispose the old checkout's chats and reopen in
  // the new one so the running agent actually moves with the pill.
  const chatsCwdRef = useRef<string | null>(null)
  useEffect(() => {
    // A transient empty derivation (workspace/worktree briefly unresolved) must
    // never tear down a live agent — wait for a real path.
    if (!cwd) return
    // First run records the cwd the mount effect spawned/adopted at; only a
    // later change (a worktree switch) triggers a reinit.
    if (chatsCwdRef.current === null) {
      chatsCwdRef.current = cwd
      return
    }
    if (chatsCwdRef.current === cwd) return
    chatsCwdRef.current = cwd

    // Tear down every chat bound to the old checkout, then reopen for the new.
    disposeAgentChats(openChatsRef.current)
    readyByKey.current = {}
    setOpenChats([])
    setActiveAgentKey(null)
    setReadyTick((n) => n + 1)

    const signal = { cancelled: false }
    void openInitialChat(signal)
    return () => { signal.cancelled = true }
  }, [cwd, openInitialChat])

  // Mirror the live chat bookkeeping into the session registry so a remount
  // (canvas<->dock move) can re-adopt the same chats. Synced on every change so
  // the snapshot is never stale when the unmount/remount happens.
  useEffect(() => {
    saveAgentPanelSession(panelId, {
      openChats,
      activeAgentKey,
      readyByKey: readyByKey.current,
    })
  }, [panelId, openChats, activeAgentKey, readyTick])

  // Default-pick once auth resolves — applies to the active chat only. Other
  // open chats keep whichever model they were created with; the user can swap
  // each independently. Prefers the configured default; otherwise falls back
  // to the first available model.
  useEffect(() => {
    if (!activeAgentKey) return
    if (selectedModel) return
    if (availableModels.length === 0) return
    const def = loadDefaultModel()
    const pick = def && availableModels.some((m) => m.provider === def.provider && m.model === def.model)
      ? def
      : { provider: availableModels[0].provider, model: availableModels[0].model }
    useAgentStore.getState().setModel(activeAgentKey, pick)
  }, [availableModels, selectedModel, activeAgentKey])

  // Pi writes session entries to disk automatically; no renderer-side persist
  // needed here. The sidebar refreshes when `running` flips false.

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    if (!activeAgentKey) return
    // Read the draft straight from the active slice so we never send a stale
    // closure value mid-stream.
    const cur = useAgentStore.getState().panels[activeAgentKey]
    if (!cur?.model) return
    const text = (cur?.draft ?? '').trim()
    const images = (cur?.draftImages ?? []).slice()
    if (!text && images.length === 0) return
    const isSteering = running
    useAgentStore.getState().appendUser(activeAgentKey, isSteering ? `(steer) ${text}` : text)
    setDraft('')
    setDraftImages([])
    try {
      if (isSteering) {
        await window.electronAPI.agentSteer(activeAgentKey, text, images.length > 0 ? images : undefined)
      } else {
        await window.electronAPI.agentPrompt(activeAgentKey, text, images.length > 0 ? images : undefined)
      }
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(activeAgentKey, `Send failed: ${msg}`, 'error')
    }
  }, [running, activeAgentKey, setDraft, setDraftImages])

  const handleInterrupt = useCallback(async () => {
    if (!activeAgentKey) return
    try { await window.electronAPI.agentInterrupt(activeAgentKey) }
    catch (err) { log.warn('[AgentPanel] interrupt failed', err) }
  }, [activeAgentKey])

  const handlePickModel = useCallback(async (m: { provider: string; model: string }) => {
    setModelPickerOpen(false)
    if (!activeAgentKey) return
    const ref: AgentModelRef = { provider: m.provider, model: m.model }
    useAgentStore.getState().setModel(activeAgentKey, ref)
    try { await window.electronAPI.agentSetModel(activeAgentKey, ref) }
    catch (err) { log.warn('[AgentPanel] setModel failed', err) }
  }, [activeAgentKey])

  const handleNewChat = useCallback(async () => {
    const myGen = ++openGenRef.current
    const key = newAgentKey()
    useAgentStore.getState().init(key)
    // New chats always start with the user-configured default. If no default
    // is set, fall through to the default-pick effect (first available).
    const model = loadDefaultModel()
    if (model) useAgentStore.getState().setModel(key, model)
    setOpenChats((prev) => [...prev, { agentKey: key, sessionFile: null }])
    setActiveAgentKey(key)
    setView('chat')
    if (myGen !== openGenRef.current) return
    await createAgent(key, model)
    if (myGen !== openGenRef.current) return
    void refreshChats()
  }, [createAgent, refreshChats, newAgentKey])

  const handleOpenChat = useCallback(async (sessionFile: string) => {
    // Already open in this panel? Switch to it — its pi keeps running, state
    // is preserved, and there's no respawn cost.
    const existing = openChats.find((c) => c.sessionFile === sessionFile)
    if (existing) {
      setActiveAgentKey(existing.agentKey)
      setView('chat')
      return
    }
    // Otherwise spawn a new chat session bound to that on-disk file. Prefer
    // the model recorded in this session's most recent model_change; if none
    // is present, fall back to the configured default (and finally to the
    // default-pick effect once auth resolves).
    const myGen = ++openGenRef.current
    const key = newAgentKey()
    useAgentStore.getState().init(key)
    const entry = chats.find((c) => c.path === sessionFile)
    const model: AgentModelRef | null = entry?.lastModel
      ? { provider: entry.lastModel.provider, model: entry.lastModel.model }
      : loadDefaultModel()
    if (model) useAgentStore.getState().setModel(key, model)
    setView('chat')
    try {
      const transcript = await window.electronAPI.agentLoadSessionMessages(sessionFile)
      if (myGen !== openGenRef.current) return
      useAgentStore.getState().loadMessages(key, transcript as StoreMessage[])
    } catch (err) {
      log.warn('[AgentPanel] load transcript failed', err)
    }
    if (myGen !== openGenRef.current) return
    setOpenChats((prev) => [...prev, { agentKey: key, sessionFile }])
    setActiveAgentKey(key)
    await createAgent(key, model, sessionFile)
  }, [openChats, chats, createAgent, newAgentKey])

  const handleCloseChat = useCallback((key: string) => {
    // Dispose pi for this chat without deleting its on-disk session file.
    // Used by the sidebar's "close" affordance on currently-open chats.
    readyByKey.current[key] = false
    window.electronAPI.agentDispose(key).catch(() => { /* */ })
    useAgentStore.getState().dispose(key)
    const remaining = openChatsRef.current.filter((c) => c.agentKey !== key)
    setOpenChats(remaining)
    if (activeAgentKey === key) {
      if (remaining.length > 0) {
        setActiveAgentKey(remaining[remaining.length - 1].agentKey)
      } else {
        setActiveAgentKey(null)
        void handleNewChat()
      }
    }
  }, [activeAgentKey, handleNewChat])

  const handleDeleteChat = useCallback(async (sessionFile: string) => {
    // If this chat is currently open in the panel, dispose its pi session and
    // drop it from openChats first. If it was active, fall back to another
    // open chat — or auto-spawn a fresh one so the panel is never empty.
    const open = openChatsRef.current.find((c) => c.sessionFile === sessionFile)
    if (open) handleCloseChat(open.agentKey)
    try {
      await window.electronAPI.agentDeleteSession(sessionFile)
    } catch (err) {
      log.warn('[AgentPanel] deleteSession failed', err)
    }
    await refreshChats()
  }, [refreshChats, handleCloseChat])

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const selectedProviderConnected = useMemo(() => {
    if (!selectedModel) return true
    const s = providerStatuses.find((s) => s.id === selectedModel.provider)
    return !!s?.connected
  }, [selectedModel, providerStatuses])

  // A model remembered from a provider the user has since cleared (saved
  // default, or a resumed session's lastModel) should reset, not prompt a
  // reconnect. Once real auth state is in, drop the stale pick — the auto-pick
  // effect above then selects from whatever providers remain, or the "no
  // model" hint shows when none do.
  useEffect(() => {
    if (!authLoaded || !activeAgentKey || !selectedModel) return
    if (selectedProviderConnected) return
    useAgentStore.getState().setModel(activeAgentKey, null)
    clearModelPrefsForProvider(selectedModel.provider)
  }, [authLoaded, activeAgentKey, selectedModel, selectedProviderConnected])

  // With no model the composer is disabled and the placeholder doubles as the
  // hint explaining why. The disconnected-provider term only matters in the
  // window before the first authStatus() resolves — once it does, the reset
  // effect above nulls the model and the no-model state takes over.
  const composerDisabled = !selectedModel || !selectedProviderConnected
  const composerPlaceholder = !selectedModel
    ? 'No model selected or no provider is set up yet'
    : undefined

  const filteredChats = useMemo(() => {
    if (!chatSearch.trim()) return chats
    const q = chatSearch.trim().toLowerCase()
    return chats.filter((c) => c.title.toLowerCase().includes(q))
  }, [chats, chatSearch])

  /** Sidebar uses this to mark chats that currently have a live pi process in
   *  this panel — so the user can see what's running in the background and
   *  close it without deleting the on-disk session. */
  const openSessionFiles = useMemo(
    () => new Set(openChats.map((c) => c.sessionFile).filter((s): s is string => !!s)),
    [openChats],
  )

  // The agent panel's own settings (custom agents / prompts).
  const openSettings = useCallback(() => {
    setView('settings')
  }, [])

  // Refresh the slash-command list when the user opens the "/" popup, so newly
  // installed skills/prompts appear without reopening the panel.
  const handleSlashOpen = useCallback(() => {
    if (activeAgentKey) void refreshCommands(activeAgentKey)
  }, [activeAgentKey, refreshCommands])

  // Provider sign-in now lives in the main Cate Settings (Providers section),
  // not in the agent panel. Opening it there keeps a single source of truth for
  // credentials, which are global and shared across all workspaces.
  const openProviderSettings = useCallback(() => {
    useUIStore.getState().openSettings('providers')
  }, [])


  // ---------------------------------------------------------------------------
  // Stats polling — refresh after every assistant turn (cheap; the call just
  // reads pi's already-computed counters). We pull state too so the renderer
  // mirrors pi's authoritative thinking level / auto-flags / session name.
  // ---------------------------------------------------------------------------

  const refreshStatsAndState = useCallback(async () => {
    if (!activeAgentKey) return
    const key = activeAgentKey
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
          updateChatSessionFile(key, st.sessionFile)
        }
      }
    } catch {
      /* RPC not ready yet — silently retry on the next tick. */
    }
  }, [activeAgentKey, updateChatSessionFile])

  // Pull stats on every transition out of running (turn finished) and once at mount.
  useEffect(() => {
    if (running || !sessionReady) return
    void refreshStatsAndState()
  }, [running, sessionReady, refreshStatsAndState, readyTick])

  // Learn the on-disk session file for EVERY open chat, not just the active one.
  // Pi assigns a file on the first turn; refreshStatsAndState only runs for the
  // active chat, so a background chat would keep sessionFile:null and reopening
  // its sidebar row would take the create-branch and spawn a SECOND pi bound to
  // the same file the still-running original owns. Poll any ready chat missing a
  // file (cheap get_state) so handleOpenChat always matches the live chat.
  useEffect(() => {
    const pending = openChats.filter(
      (c) => !c.sessionFile && readyByKey.current[c.agentKey],
    )
    if (pending.length === 0) return
    let cancelled = false
    void (async () => {
      for (const chat of pending) {
        try {
          const st = (await window.electronAPI.agentGetState(chat.agentKey)) as AgentRpcState | null
          if (cancelled) return
          if (st?.sessionFile) updateChatSessionFile(chat.agentKey, st.sessionFile)
        } catch {
          /* pi not ready yet — retried on the next tick */
        }
      }
    })()
    return () => { cancelled = true }
  }, [openChats, running, readyTick, updateChatSessionFile])

  // ---------------------------------------------------------------------------
  // Fork map refresh — keep a local mapping of pi entryIds so the hover "fork
  // from here" gesture has something to point at. We only refresh after a turn
  // (when message_count changes) to keep traffic down.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (running || !sessionReady) return
    if (!activeAgentKey) return
    const key = activeAgentKey
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
  }, [running, sessionReady, messages.length, activeAgentKey, readyTick])

  // ---------------------------------------------------------------------------
  // Extension UI dialog response
  // ---------------------------------------------------------------------------

  const handleUiResponse = useCallback(
    (response: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) => {
      if (!activeAgentKey) return
      try {
        window.electronAPI.agentUiResponse(activeAgentKey, response)
      } catch (err) {
        log.warn('[AgentPanel] uiResponse failed', err)
      }
      useAgentStore.getState().resolveUiRequest(activeAgentKey, response.id)
    },
    [activeAgentKey],
  )

  // ---------------------------------------------------------------------------
  // Compaction / retry controls
  // ---------------------------------------------------------------------------

  const handleManualCompact = useCallback(async () => {
    if (!activeAgentKey) return
    const key = activeAgentKey
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
  }, [activeAgentKey, refreshStatsAndState])

  const handleAbortRetry = useCallback(async () => {
    if (!activeAgentKey) return
    try { await window.electronAPI.agentAbortRetry(activeAgentKey) }
    catch (err) { log.warn('[AgentPanel] abortRetry failed', err) }
  }, [activeAgentKey])

  const handleToggleAutoCompaction = useCallback(async () => {
    if (!activeAgentKey) return
    const next = !autoCompactionEnabled
    useAgentStore.getState().setAutoCompactionEnabled(activeAgentKey, next)
    try { await window.electronAPI.agentSetAutoCompaction(activeAgentKey, next) }
    catch (err) { log.warn('[AgentPanel] setAutoCompaction failed', err) }
  }, [activeAgentKey, autoCompactionEnabled])

  // ---------------------------------------------------------------------------
  // Thinking level
  // ---------------------------------------------------------------------------

  const handlePickThinkingLevel = useCallback(async (level: AgentThinkingLevel) => {
    if (!activeAgentKey) return
    useAgentStore.getState().setThinkingLevel(activeAgentKey, level)
    try { await window.electronAPI.agentSetThinkingLevel(activeAgentKey, level) }
    catch (err) { log.warn('[AgentPanel] setThinkingLevel failed', err) }
  }, [activeAgentKey])

  // ---------------------------------------------------------------------------
  // Fork
  // ---------------------------------------------------------------------------

  const handleFork = useCallback(async (entryId: string) => {
    if (!activeAgentKey) return
    const key = activeAgentKey
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
  }, [activeAgentKey, forkMap, refreshStatsAndState, setDraft])

  // ---------------------------------------------------------------------------
  // Plan mode (cate-plan-mode extension)
  // ---------------------------------------------------------------------------

  const planModeActive = useMemo(
    () => extensionStatuses.some((s) => s.key === 'plan-mode'),
    [extensionStatuses],
  )

  const handleTogglePlanMode = useCallback(async () => {
    if (!activeAgentKey) return
    try { await window.electronAPI.agentPrompt(activeAgentKey, '/plan') }
    catch (err) { log.warn('[AgentPanel] toggle plan mode failed', err) }
  }, [activeAgentKey])

  const handleImplementPlan = useCallback(async () => {
    if (!activeAgentKey) return
    const key = activeAgentKey
    try {
      // The cate-plan-mode extension clears plan mode and starts the implement
      // turn itself (via a custom message), so there's no synthetic user prompt.
      await window.electronAPI.agentPrompt(key, '/apply-plan')
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Implement failed: ${msg}`, 'error')
    }
  }, [activeAgentKey])

  const handleRefinePlan = useCallback(async (text: string) => {
    if (!activeAgentKey) return
    const key = activeAgentKey
    try { await window.electronAPI.agentPrompt(key, text) }
    catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Refine failed: ${msg}`, 'error')
    }
  }, [activeAgentKey])

  const handleClearAndImplement = useCallback(async () => {
    if (!activeAgentKey) return
    const key = activeAgentKey
    try {
      useAgentStore.getState().setCompaction(key, { active: true, reason: 'manual' })
      await window.electronAPI.agentCompact(key)
      useAgentStore.getState().setCompaction(key, { active: false })
      // 'fresh' tells the extension to restate the full plan: compaction dropped
      // the original plan_complete call from context.
      await window.electronAPI.agentPrompt(key, '/apply-plan fresh')
    } catch (err) {
      const msg = toErrorMessage(err)
      useAgentStore.getState().appendSystem(key, `Clear & implement failed: ${msg}`, 'error')
      useAgentStore.getState().setCompaction(key, { active: false, lastErrorMessage: msg })
    } finally {
      void refreshStatsAndState()
    }
  }, [activeAgentKey, refreshStatsAndState])

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
  // <FileDropOverlay/> (the root is marked data-filedrop="agent"); the chat
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
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="relative w-full h-full flex bg-surface-4 text-primary min-h-0 overflow-hidden"
      data-filedrop="agent"
      onDragOver={handlePanelDragOver}
      onDrop={handleDrop}
    >
      {sidebarOpen && (
        <AgentSidebar
          chats={filteredChats}
          currentSessionFile={currentSessionFile}
          openSessionFiles={openSessionFiles}
          search={chatSearch}
          onSearchChange={setChatSearch}
          onNewChat={handleNewChat}
          onOpenChat={handleOpenChat}
          onDeleteChat={handleDeleteChat}
          onCloseChat={(sessionFile) => {
            const open = openChats.find((c) => c.sessionFile === sessionFile)
            if (open) handleCloseChat(open.agentKey)
          }}
          onOpenSettings={() => openSettings()}
          onCollapse={() => setSidebarOpen(false)}
          settingsActive={view === 'settings'}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Header — only the sidebar toggle (when collapsed) and the model
         *  picker / current-view title. Session controls live in the input. */}
        <div className="flex items-center gap-1 px-2 h-10 shrink-0">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-hover"
              title="Open sidebar"
            >
              <SidebarIcon size={14} />
            </button>
          )}

          {view === 'chat' ? (
            <div className="relative">
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => { setModelPickerOpen((v) => { if (!v) void refreshModels(); return !v }) }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-primary hover:bg-hover"
              >
                <CateLogo size={12} className="text-agent-light" />
                <span className="truncate max-w-[220px]">
                  {selectedModel ? selectedModel.model : 'Pick a model'}
                </span>
                <CaretDown size={10} className="text-muted" />
              </button>
              {modelPickerOpen && (
                <ModelPickerDropdown
                  models={availableModels}
                  selected={selectedModel}
                  onPick={handlePickModel}
                  onClose={() => setModelPickerOpen(false)}
                  onManage={() => { setModelPickerOpen(false); openProviderSettings() }}
                />
              )}
            </div>
          ) : (
            <div className="px-2 py-1 text-[12px] font-medium text-primary flex items-center gap-1.5">
              <Gear size={12} />
              Settings
            </div>
          )}
        </div>

        {/* Body */}
        {view === 'settings' ? (
          <SettingsView
            workspaceId={workspaceId}
            cwd={cwd}
            onBack={() => setView('chat')}
            onRefresh={() => { if (activeAgentKey) void refreshCommands(activeAgentKey) }}
          />
        ) : (
        <div className="relative flex-1 flex flex-col min-h-0">
            {!selectedModel ? (
              <div className="px-3 py-2 bg-agent/10 border-b border-agent/30 flex items-center gap-2 text-[12px] text-primary">
                <span className="flex-1 truncate">
                  No model selected or no provider is set up yet.
                </span>
                <button
                  onClick={() => {
                    if (availableModels.length > 0) {
                      void refreshModels()
                      setModelPickerOpen(true)
                    } else {
                      openProviderSettings()
                    }
                  }}
                  className="px-2 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium shrink-0"
                >
                  {availableModels.length > 0 ? 'Pick model' : 'Set up provider'}
                </button>
              </div>
            ) : null}

            {/* Retry status is now shown inline in the chat thread */}
            <ExtensionWidget widgets={extensionWidgets} placement="aboveEditor" />
            <QueueBadges steering={steeringQueue} followUp={followUpQueue} />

            {messages.length === 0 ? (
              <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-8 min-h-0">
                <div className="w-full max-w-[520px] flex flex-col items-center">
                  <div className="w-12 h-12 rounded-2xl bg-agent/15 flex items-center justify-center mb-4">
                    <CateLogo size={22} className="text-agent-light" />
                  </div>
                  <div className="text-[16px] font-medium text-primary mb-3 text-center">
                    What should we work on?
                  </div>
                  <div className="w-full -mx-3">
                    <ChatInput
                      draft={draft}
                      onChange={setDraft}
                      onSubmit={handleSend}
                      onStop={handleInterrupt}
                      disabled={composerDisabled}
                      running={running}
                      textareaRef={textareaRef}
                      commands={commands}
                      images={draftImages}
                      onAddImage={handleAddImage}
                      onRemoveImage={handleRemoveImage}
                      onPaste={handlePaste}
                      onDrop={handleDrop}
                      stats={stats}
                      thinkingLevel={thinkingLevel}
                      onPickThinkingLevel={handlePickThinkingLevel}
                      autoCompactionEnabled={autoCompactionEnabled}
                      onManualCompact={handleManualCompact}
                      onToggleAutoCompaction={handleToggleAutoCompaction}
                      compactionActive={compaction.active}
                      planModeActive={planModeActive}
                      onTogglePlanMode={handleTogglePlanMode}
                      onSlashOpen={handleSlashOpen}
                      placeholder={composerPlaceholder ?? 'Ask the agent anything about this workspace…'}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
                <ChatThread
                  scrollKey={activeAgentKey ?? ''}
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
                <ChatInput
                  draft={draft}
                  onChange={setDraft}
                  onSubmit={handleSend}
                  onStop={handleInterrupt}
                  disabled={composerDisabled}
                  running={running}
                  textareaRef={textareaRef}
                  commands={commands}
                  images={draftImages}
                  onAddImage={handleAddImage}
                  onRemoveImage={handleRemoveImage}
                  onPaste={handlePaste}
                  onDrop={handleDrop}
                  stats={stats}
                  thinkingLevel={thinkingLevel}
                  onPickThinkingLevel={handlePickThinkingLevel}
                  autoCompactionEnabled={autoCompactionEnabled}
                  onManualCompact={handleManualCompact}
                  onToggleAutoCompaction={handleToggleAutoCompaction}
                  compactionActive={compaction.active}
                  planModeActive={planModeActive}
                  onTogglePlanMode={handleTogglePlanMode}
                  onSlashOpen={handleSlashOpen}
                  placeholder={composerPlaceholder}
                />
              </>
            )}

            <ExtensionStatusBar entries={extensionStatuses} />
          </div>
        )}
      </div>
    </div>
  )
}
