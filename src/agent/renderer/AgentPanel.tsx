// =============================================================================
// AgentPanel — Pi coding-agent chat panel.
//
// Layout (Codex-style):
//   ┌──────────────┬───────────────────────────────────────────────┐
//   │  Sidebar     │  Header  (model picker · stop)                │
//   │  • New chat  │ ───────────────────────────────────────────── │
//   │  • Recent    │                                               │
//   │  • Settings  │           Welcome / thread / settings         │
//   └──────────────┴───────────────────────────────────────────────┘
//
// The sidebar is collapsible (hamburger in header). The "settings" view
// replaces the main column; the only way out is its back arrow — no double
// close paths.
//
// Chats are pi's own session files on disk (<cwd>/.cate/pi-agent/sessions/<cwd>/*.jsonl).
// The sidebar reads them via AGENT_LIST_SESSIONS; opening a row resumes that
// session by spawning pi with `--session <path>`. New chat = dispose + create
// without a session file, then pick up pi's freshly-written file from getState.
// =============================================================================

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Stop,
  PaperPlaneRight,
  CaretDown,
  CaretRight,
  CheckCircle,
  Plus,
  Sidebar as SidebarIcon,
  Gear,
  Trash,
  ChatCircleDots,
  MagnifyingGlass,
  FolderOpen,

  ClipboardText,
  Spinner,
  ArrowsClockwise,
} from '@phosphor-icons/react'
import { CateLogo } from '../../renderer/ui/CateLogo'
import log from '../../renderer/lib/logger'
import type { PanelProps } from '../../renderer/panels/types'
import { useAppStore } from '../../renderer/stores/appStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { useAgentStore } from './agentStore'
import { ProvidersView } from './ProvidersView'
import { ChatThread } from './ChatThread'
import {
  ExtensionDialog,
  ExtensionStatusBar,
  ExtensionWidget,
  ImageAttachButton,
  ImageChips,

  QueueBadges,
  readFileAsImage,
  ThinkingLevelPicker,
} from './AgentPanelChrome'
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
import { loadDefaultModel, loadLastModel, saveLastModel } from './agentModelPrefs'


function useNodePortalTarget(ref: React.RefObject<Element | null>) {
  const getTarget = useCallback(
    () => ref.current?.closest('[data-node-id]') as HTMLElement | null,
    [ref],
  )
  const toLocal = useCallback(
    (viewport: { top: number; left: number }) => {
      const target = getTarget()
      if (!target) return viewport
      const tr = target.getBoundingClientRect()
      return { top: viewport.top - tr.top, left: viewport.left - tr.left }
    },
    [getTarget],
  )
  return { getTarget, toLocal }
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

interface OpenChat {
  /** Unique IPC session key — passed as `panelId` to AGENT_* IPC channels and
   *  used as the slice key in useAgentStore. Stable for the lifetime of the
   *  chat, even if the user renames or pi assigns a sessionFile later. */
  agentKey: string
  /** Pi's on-disk session file. Null for brand-new chats until pi's getState
   *  reports one (typically right after the first turn). */
  sessionFile: string | null
}

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
  const pendingApprovals = slice?.pendingApprovals ?? []
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

  const uiRequests = slice?.uiRequests ?? []
  const currentUiRequest = uiRequests[0]

  const [providerStatuses, setProviderStatuses] = useState<AuthProviderStatus[]>([])
  const [availableModels, setAvailableModels] = useState<
    Array<{ provider: string; model: string; label?: string }>
  >([])
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [settingsScopedTo, setSettingsScopedTo] = useState<string | undefined>(undefined)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  /** Pi-session entries on disk for this workspace's cwd. Sidebar source of
   *  truth — no localStorage shadow list. */
  const [chats, setChats] = useState<AgentSessionListEntry[]>([])
  const [chatSearch, setChatSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<AgentImageAttachment[]>([])
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

  // ---------------------------------------------------------------------------
  // Auth/provider refresh
  // ---------------------------------------------------------------------------

  const refreshAuth = useCallback(async () => {
    try {
      const statuses = await window.electronAPI.authStatus()
      setProviderStatuses(statuses)
    } catch (err) {
      log.warn('[AgentPanel] refreshAuth failed', err)
    }
  }, [])

  useEffect(() => { refreshAuth() }, [refreshAuth])
  useEffect(() => { if (view === 'chat') refreshAuth() }, [view, refreshAuth])

  const refreshModels = useCallback(async (key?: string) => {
    const k = key ?? activeAgentKey
    if (!k) return
    try {
      const piModels = await window.electronAPI.agentGetAvailableModels(k)
      if (piModels.length > 0) {
        setAvailableModels(piModels.map((m) => ({ provider: m.provider, model: m.id, label: m.id })))
      }
    } catch { /* session may not support this RPC */ }
  }, [activeAgentKey])

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
      // the RPC session is up. Fetch after a successful create.
      void refreshCommands(key)
      void refreshModels(key)
    } catch (err) {
      // Transient errors during rapid chat-switching are expected. Genuine
      // startup failures surface via the `if (!res.ok)` branch above.
      markReady(key, false)
      log.warn('[AgentPanel] createAgent failed', err)
    }
  }, [workspaceId, cwd, refreshCommands, markReady])

  // Mount: open the most-recent on-disk session as the initial chat. Unmount:
  // dispose every chat session this panel ever spawned. Background pi
  // processes for non-active chats continue running until this cleanup runs.
  useEffect(() => {
    let cancelled = false
    const myGen = ++openGenRef.current

    void (async () => {
      let resume: AgentSessionListEntry | null = null
      try {
        if (cwd) {
          const list = await window.electronAPI.agentListSessions(cwd)
          if (cancelled || myGen !== openGenRef.current) return
          if (list.length > 0) resume = list[0]
        }
      } catch { /* ignore — list failures fall through to fresh session */ }

      if (cancelled || myGen !== openGenRef.current) return
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
          if (cancelled || myGen !== openGenRef.current) return
          useAgentStore.getState().loadMessages(key, transcript as StoreMessage[])
        } catch (err) { log.warn('[AgentPanel] load transcript failed', err) }
      }
      if (cancelled || myGen !== openGenRef.current) return
      // Set state BEFORE creating pi so the unmount cleanup is guaranteed to
      // see this key in openChatsRef and dispose its pi process.
      setOpenChats([{ agentKey: key, sessionFile: resume?.path ?? null }])
      setActiveAgentKey(key)
      await createAgent(key, initialModel, resume?.path)
    })()

    return () => {
      cancelled = true
      for (const c of openChatsRef.current) {
        readyByKey.current[c.agentKey] = false
        window.electronAPI.agentDispose(c.agentKey).catch(() => { /* */ })
        useAgentStore.getState().dispose(c.agentKey)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId])

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
    saveLastModel(pick)
  }, [availableModels, selectedModel, activeAgentKey])

  // Pi writes session entries to disk automatically; no renderer-side persist
  // needed here. The sidebar refreshes when `running` flips false.

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    if (!activeAgentKey) return
    const text = draft.trim()
    const images = draftImages.slice()
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
      const msg = err instanceof Error ? err.message : String(err)
      useAgentStore.getState().appendSystem(activeAgentKey, `Send failed: ${msg}`, 'error')
    }
  }, [draft, draftImages, running, activeAgentKey])

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
    saveLastModel(ref)
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

  const handleApproval = useCallback(
    async (toolCallId: string, decision: 'allow' | 'deny') => {
      if (!activeAgentKey) return
      useAgentStore.getState().resolveApproval(activeAgentKey, toolCallId)
      try {
        await window.electronAPI.agentToolDecision(activeAgentKey, toolCallId, decision)
        if (decision === 'deny') {
          useAgentStore.getState().updateToolCall(activeAgentKey, toolCallId, { status: 'denied' })
        }
      } catch (err) {
        log.warn('[AgentPanel] tool decision failed', err)
      }
    },
    [activeAgentKey],
  )

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const selectedProviderConnected = useMemo(() => {
    if (!selectedModel) return true
    const s = providerStatuses.find((s) => s.id === selectedModel.provider)
    return !!s?.connected
  }, [selectedModel, providerStatuses])

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

  const openSettings = useCallback((providerId?: string) => {
    setSettingsScopedTo(providerId)
    setView('settings')
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
      const msg = err instanceof Error ? err.message : String(err)
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
      const msg = err instanceof Error ? err.message : String(err)
      useAgentStore.getState().appendSystem(key, `Fork failed: ${msg}`, 'error')
    }
  }, [activeAgentKey, forkMap, refreshStatsAndState])

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
      await window.electronAPI.agentPrompt(key, '/apply-plan')
      await window.electronAPI.agentPrompt(key, 'Now execute the plan above.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      useAgentStore.getState().appendSystem(key, `Implement failed: ${msg}`, 'error')
    }
  }, [activeAgentKey])

  const handleRefinePlan = useCallback(async (text: string) => {
    if (!activeAgentKey) return
    const key = activeAgentKey
    try { await window.electronAPI.agentPrompt(key, text) }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
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
      await window.electronAPI.agentPrompt(key, '/apply-plan')
      await window.electronAPI.agentPrompt(key, 'Now execute the plan above.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
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
  }, [])

  const handleRemoveImage = useCallback((idx: number) => {
    setDraftImages((prev) => prev.filter((_, i) => i !== idx))
  }, [])

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

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    // Files dragged from Cate's own Explorer come through as a JSON payload of
    // absolute paths under `application/cate-files`. Insert them into the draft
    // as @-mentions instead of trying to read them as images.
    const cateRaw = e.dataTransfer?.getData('application/cate-files')
    if (cateRaw) {
      e.preventDefault()
      try {
        const paths = JSON.parse(cateRaw) as string[]
        if (Array.isArray(paths) && paths.length > 0) {
          const mentions = paths.map((p) => `@${p}`).join(' ')
          setDraft((prev) => (prev ? `${prev}${prev.endsWith(' ') ? '' : ' '}${mentions} ` : `${mentions} `))
        }
      } catch { /* ignore malformed payload */ }
      return
    }
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    for (const file of Array.from(e.dataTransfer.files)) {
      const img = await readFileAsImage(file)
      if (img) handleAddImage(img)
    }
  }, [handleAddImage])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="w-full h-full flex bg-surface-4 text-primary min-h-0 overflow-hidden">
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
          onOpenSettings={() => openSettings(undefined)}
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
              className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-white/5"
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
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-primary hover:bg-white/5"
              >
                <CateLogo size={12} className="text-agent-light" />
                <span className="truncate max-w-[220px]">
                  {selectedModel ? selectedModel.model : 'Pick a model'}
                </span>
                <CaretDown size={10} className="text-muted" />
              </button>
              {modelPickerOpen && (
                <ModelPicker
                  models={availableModels}
                  selected={selectedModel}
                  onPick={handlePickModel}
                  onClose={() => setModelPickerOpen(false)}
                  onManage={() => { setModelPickerOpen(false); openSettings(undefined) }}
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
            commands={commands}
            workspaceId={workspaceId}
            cwd={cwd}
            scopedProviderId={settingsScopedTo}
            availableModels={availableModels}
            onBack={() => setView('chat')}
            onRefresh={() => { if (activeAgentKey) void refreshCommands(activeAgentKey) }}
          />
        ) : (
          <div className="relative flex-1 flex flex-col min-h-0">
            {selectedModel && !selectedProviderConnected && (
              <div className="px-3 py-2 bg-agent/10 border-b border-agent/30 flex items-center gap-2 text-[12px] text-primary">
                <span className="flex-1 truncate">
                  Connect <strong>{selectedModel.provider}</strong> to start.
                </span>
                <button
                  onClick={() => openSettings(selectedModel.provider)}
                  className="px-2 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium shrink-0"
                >
                  Connect
                </button>
              </div>
            )}

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
                      disabled={!!selectedModel && !selectedProviderConnected}
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
                      placeholder={
                        !selectedModel ? 'Pick a model to start…'
                          : !selectedProviderConnected ? `Connect ${selectedModel.provider} to start…`
                          : 'Ask the agent anything about this workspace…'
                      }
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
                <ChatThread
                  messages={messages}
                  pendingApprovals={pendingApprovals}
                  onApproval={handleApproval}
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
                  disabled={!!selectedModel && !selectedProviderConnected}
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

// -----------------------------------------------------------------------------
// Sidebar
// -----------------------------------------------------------------------------

function AgentSidebar({
  chats,
  currentSessionFile,
  openSessionFiles,
  search,
  onSearchChange,
  onNewChat,
  onOpenChat,
  onDeleteChat,
  onCloseChat,
  onOpenSettings,
  onCollapse,
  settingsActive,
}: {
  chats: AgentSessionListEntry[]
  currentSessionFile: string | null
  openSessionFiles: Set<string>
  search: string
  onSearchChange: (s: string) => void
  onNewChat: () => void
  onOpenChat: (sessionFile: string) => void
  onDeleteChat: (sessionFile: string) => void
  onCloseChat: (sessionFile: string) => void
  onOpenSettings: () => void
  onCollapse: () => void
  settingsActive: boolean
}) {
  const grouped = useMemo(() => groupChats(chats), [chats])

  return (
    <div className="w-[200px] shrink-0 flex flex-col border-r border-subtle bg-black/15 min-h-0">
      <div className="flex items-center gap-1 px-2 h-10 border-b border-subtle shrink-0">
        <button
          onClick={onCollapse}
          className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-white/5"
          title="Collapse sidebar"
        >
          <SidebarIcon size={14} />
        </button>
        <div className="flex-1" />
        <button
          onClick={onNewChat}
          className="p-1.5 rounded-md text-agent-light hover:text-primary hover:bg-agent/20"
          title="New chat"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="px-2 pt-2 pb-2 shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/20 border border-white/5">
          <MagnifyingGlass size={11} className="text-muted shrink-0" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search chats"
            className="flex-1 bg-transparent text-[11px] text-primary placeholder:text-muted outline-none min-w-0"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-2 min-h-0">
        {chats.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted">
            No chats yet.
          </div>
        ) : (
          grouped.map(([label, items]) => (
            <div key={label} className="mb-3">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted/70 font-semibold">
                {label}
              </div>
              {items.map((c) => (
                <ChatRow
                  key={c.path}
                  chat={c}
                  active={c.path === currentSessionFile}
                  onOpen={() => onOpenChat(c.path)}
                  onDelete={() => onDeleteChat(c.path)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="p-2 shrink-0">
        <button
          onClick={onOpenSettings}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] ${
            settingsActive
              ? 'bg-white/10 text-primary'
              : 'text-muted hover:bg-white/5 hover:text-primary'
          }`}
        >
          <Gear size={12} />
          Settings
        </button>
      </div>
    </div>
  )
}

function ChatRow({
  chat,
  active,
  onOpen,
  onDelete,
}: {
  chat: AgentSessionListEntry
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={`group flex items-center gap-1 px-1 rounded-md ${
        active ? 'bg-white/10' : 'hover:bg-white/5'
      }`}
    >
      <button
        onClick={onOpen}
        className="flex-1 min-w-0 flex items-center gap-1.5 px-1 py-1 text-left"
        title={`${chat.title}\n${chat.messageCount} messages · ${new Date(chat.updatedAt).toLocaleString()}`}
      >
        <ChatCircleDots size={11} className={chat.named ? 'text-agent-light shrink-0' : 'text-muted shrink-0'} />
        <span className="truncate text-[11.5px] text-primary">{chat.title}</span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="p-1 rounded-md text-muted hover:text-primary hover:bg-white/10 opacity-0 group-hover:opacity-100"
        title="Delete chat"
      >
        <Trash size={10} />
      </button>
    </div>
  )
}

function groupChats(
  chats: AgentSessionListEntry[],
): Array<[string, AgentSessionListEntry[]]> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 3600 * 1000
  const startOfWeek = startOfToday - 7 * 24 * 3600 * 1000
  const buckets: Record<string, AgentSessionListEntry[]> = {
    Today: [], Yesterday: [], 'This week': [], Earlier: [],
  }
  for (const c of chats) {
    const t = Date.parse(c.updatedAt)
    if (t >= startOfToday) buckets.Today.push(c)
    else if (t >= startOfYesterday) buckets.Yesterday.push(c)
    else if (t >= startOfWeek) buckets['This week'].push(c)
    else buckets.Earlier.push(c)
  }
  return Object.entries(buckets).filter(([, items]) => items.length > 0)
}

// -----------------------------------------------------------------------------
// Chat input (bottom-of-thread)
// -----------------------------------------------------------------------------

function ChatInput({
  draft,
  onChange,
  onSubmit,
  onStop,
  disabled,
  running,
  textareaRef,
  commands,
  images,
  onAddImage,
  onRemoveImage,
  onPaste,
  onDrop,
  stats,
  thinkingLevel,
  onPickThinkingLevel,
  autoCompactionEnabled,
  onManualCompact,
  onToggleAutoCompaction,
  compactionActive,
  planModeActive,
  onTogglePlanMode,
  placeholder: placeholderOverride,
}: {
  draft: string
  onChange: (s: string) => void
  onSubmit: () => void
  onStop: () => void
  disabled: boolean
  running: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement>
  commands: AgentSlashCommand[]
  images: AgentImageAttachment[]
  onAddImage: (img: AgentImageAttachment) => void
  onRemoveImage: (idx: number) => void
  onPaste: (e: React.ClipboardEvent) => void
  onDrop: (e: React.DragEvent) => void
  stats: import('../../shared/types').AgentSessionStats | null
  thinkingLevel: AgentThinkingLevel | null
  onPickThinkingLevel: (level: AgentThinkingLevel) => void
  autoCompactionEnabled: boolean
  onManualCompact: () => void
  onToggleAutoCompaction: () => void
  compactionActive: boolean
  planModeActive: boolean
  onTogglePlanMode: () => void
  placeholder?: string
}) {
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [draft, textareaRef])

  // Slash popup is active when the draft starts with "/" and has no spaces
  // before the cursor — i.e. the user is still picking a command name.
  const slashMatch = useMemo(() => {
    if (!draft.startsWith('/')) return null
    if (draft.includes(' ') || draft.includes('\n')) return null
    return draft.slice(1).toLowerCase()
  }, [draft])

  const filteredCommands = useMemo(() => {
    if (slashMatch == null) return []
    return commands.filter((c) => c.name.toLowerCase().startsWith(slashMatch))
  }, [slashMatch, commands])

  const popupOpen = slashMatch != null && filteredCommands.length > 0
  const [selectedIdx, setSelectedIdx] = useState(0)
  useEffect(() => { setSelectedIdx(0) }, [slashMatch])

  const acceptCommand = (cmd: AgentSlashCommand): void => {
    // Insert "/<name> " so the user can immediately type the argument.
    onChange(`/${cmd.name} `)
    // Refocus textarea so they can keep typing.
    queueMicrotask(() => textareaRef.current?.focus())
  }

  const canSend = !disabled && (draft.trim().length > 0 || images.length > 0)
  const [dragOver, setDragOver] = useState(false)

  // Accept either an internal file drag (cate-files / cate-file) or external
  // image files. Returning true tells the dragover handler to claim the event
  // so that ancestor drop zones (e.g. the canvas) don't also process it.
  const acceptsDrag = (e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types
    if (!types) return false
    return (
      types.includes('application/cate-files') ||
      types.includes('application/cate-file') ||
      types.includes('Files')
    )
  }

  return (
    <div className="px-3 py-2 shrink-0">
      <div
        onDragEnter={(e) => {
          if (!acceptsDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragOver={(e) => {
          if (!acceptsDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(e) => {
          // Only clear when leaving the wrapper itself, not when moving between
          // children (relatedTarget would still be inside).
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDragOver(false)
        }}
        onDrop={(e) => {
          if (!acceptsDrag(e)) return
          e.stopPropagation()
          setDragOver(false)
          onDrop(e)
        }}
        className={`relative rounded-2xl border bg-surface-3 transition-colors ${
          dragOver
            ? 'border-agent-light ring-2 ring-agent-light/40'
            : 'border-white/10 focus-within:border-agent/50'
        }`}
      >
        {popupOpen && (
          <SlashPopup
            commands={filteredCommands}
            selectedIdx={selectedIdx}
            onPick={acceptCommand}
            onHover={setSelectedIdx}
          />
        )}
        <ImageChips images={images} onRemove={onRemoveImage} />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (popupOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIdx((i) => Math.min(i + 1, filteredCommands.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIdx((i) => Math.max(i - 1, 0))
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                acceptCommand(filteredCommands[selectedIdx])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                onChange('')
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) onSubmit()
            }
          }}
          disabled={disabled || compactionActive}
          placeholder={
            compactionActive
              ? 'Compacting context…'
              : placeholderOverride ??
                (running
                  ? 'Steer the agent…  (queues a course-correct mid-turn)'
                  : 'Message the agent…  (type / for skills, paste/drop images)')
          }
          rows={1}
          className="w-full bg-transparent px-3 py-2 text-[13px] text-primary outline-none resize-none placeholder:text-muted disabled:opacity-50"
          style={{ maxHeight: 160 }}
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <ImageAttachButton onPick={onAddImage} />
          <ThinkingLevelPicker level={thinkingLevel} onChange={onPickThinkingLevel} />
          <button
            onClick={onTogglePlanMode}
            className={`p-1.5 rounded-md ${
              planModeActive
                ? 'bg-agent/25 text-primary'
                : 'text-primary/80 hover:bg-white/5'
            }`}
            title="Plan mode: agent investigates with parallel scouts, proposes a plan, then waits for your approval."
          >
            <ClipboardText size={12} weight={planModeActive ? 'fill' : 'regular'} />
          </button>
          <CompactButton
            onManualCompact={onManualCompact}
            onToggleAutoCompaction={onToggleAutoCompaction}
            autoCompactionEnabled={autoCompactionEnabled}
            compactionActive={compactionActive}
          />
          <StatsChip stats={stats} />
          <div className="flex-1" />
          {compactionActive ? (
            <div
              className="p-1.5 rounded-full bg-agent/40 text-white"
              title="Compacting context…"
            >
              <Spinner size={12} weight="bold" className="animate-spin" />
            </div>
          ) : running ? (
            canSend ? (
              <button
                onClick={onSubmit}
                className="p-1.5 rounded-full bg-agent hover:bg-agent-light text-white"
                title="Steer"
              >
                <PaperPlaneRight size={12} weight="fill" />
              </button>
            ) : (
              <button
                onClick={onStop}
                className="p-1.5 rounded-full bg-agent hover:bg-agent-light text-white"
                title="Stop"
              >
                <Stop size={12} weight="fill" />
              </button>
            )
          ) : (
            <button
              onClick={onSubmit}
              disabled={!canSend}
              className="p-1.5 rounded-full bg-agent hover:bg-agent-light disabled:bg-white/10 disabled:text-muted text-white"
              title="Send"
            >
              <PaperPlaneRight size={12} weight="fill" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Compact button — popover with confirm + auto-compact toggle.
// -----------------------------------------------------------------------------

function CompactButton({
  onManualCompact,
  onToggleAutoCompaction,
  autoCompactionEnabled,
  compactionActive,
}: {
  onManualCompact: () => void
  onToggleAutoCompaction: () => void
  autoCompactionEnabled: boolean
  compactionActive: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { getTarget, toLocal } = useNodePortalTarget(btnRef)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    setPortalTarget(getTarget())
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, getTarget])
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const popW = 200
    let left = r.left
    if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8
    setPos(toLocal({ top: r.top - 6, left }))
  }, [open, toLocal])
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        disabled={compactionActive}
        className={`p-1.5 rounded-md hover:bg-white/5 disabled:opacity-50 ${
          autoCompactionEnabled ? 'text-primary/80' : 'text-muted/50'
        }`}
        title="Compact context"
      >
        <ArrowsClockwise size={12} className={compactionActive ? 'animate-spin' : ''} />
      </button>
      {open && pos && portalTarget && createPortal(
        <div
          ref={popoverRef}
          className="absolute w-[200px] rounded-lg border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-[9999] overflow-hidden"
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        >
          <button
            onClick={() => { setOpen(false); onManualCompact() }}
            disabled={compactionActive}
            className="w-full text-left px-3 py-2 text-[12px] text-primary hover:bg-white/5 disabled:opacity-50"
          >
            Compact now
          </button>
          <div className="border-t border-white/5">
            <button
              onClick={() => onToggleAutoCompaction()}
              className="w-full flex items-center justify-between px-3 py-2 text-[12px] text-primary hover:bg-white/5"
            >
              <span>Auto-compact</span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                autoCompactionEnabled ? 'bg-agent/20 text-agent-light' : 'bg-white/5 text-muted'
              }`}>
                {autoCompactionEnabled ? 'on' : 'off'}
              </span>
            </button>
          </div>
        </div>,
        portalTarget,
      )}
    </>
  )
}

// -----------------------------------------------------------------------------
// Stats chip — single-glance % of context used, full breakdown on hover.
// -----------------------------------------------------------------------------

function ContextRing({ percent, size = 14, stroke = 1.5 }: { percent: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const filled = circ * (Math.min(percent, 100) / 100)
  const color = percent > 85 ? '#f87171' : percent > 65 ? '#fbbf24' : 'currentColor'
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="opacity-20" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${filled} ${circ - filled}`} strokeLinecap="round" />
    </svg>
  )
}

function StatsChip({
  stats,
}: {
  stats: import('../../shared/types').AgentSessionStats | null
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { getTarget, toLocal } = useNodePortalTarget(btnRef)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    setPortalTarget(getTarget())
    const handler = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, getTarget])
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    setPos(toLocal({ top: r.top - 6, left: r.left }))
  }, [open, toLocal])
  if (!stats) return null
  const ctx = stats.contextUsage
  const ctxTokens = ctx?.tokens ?? null
  const ctxWindow = ctx?.contextWindow ?? null
  const ctxKnown = ctxTokens != null && ctxWindow != null && ctxWindow > 0
  const pctRaw =
    ctx?.percent != null
      ? ctx.percent
      : ctxKnown
      ? (ctxTokens! / ctxWindow!) * 100
      : null
  const pctRounded = pctRaw != null ? Math.round(pctRaw) : null
  const tone =
    pctRounded == null
      ? 'text-muted/70'
      : pctRounded > 85
      ? 'text-red-300'
      : pctRounded > 65
      ? 'text-amber-300'
      : 'text-muted/70'
  const fmtCost = (c: number) =>
    c >= 1 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(4)}`
  const barPct = pctRounded ?? 0
  const barColor = barPct > 85 ? 'bg-red-400' : barPct > 65 ? 'bg-amber-400' : 'bg-agent-light'
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-mono ${tone} hover:bg-white/5`}
        title="Conversation stats"
      >
        {pctRounded != null ? <ContextRing percent={pctRounded} /> : <span>-</span>}
      </button>
      {open && pos && portalTarget && createPortal(
        <div
          ref={popoverRef}
          className="absolute w-[260px] rounded-lg border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-[9999] text-[11.5px] text-primary font-mono"
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        >
          <div className="px-3 pt-3 pb-2 border-b border-white/5">
            <div className="flex justify-between items-baseline mb-1.5">
              <span className="text-muted text-[10px] uppercase tracking-wider font-semibold">Context window</span>
              <span>
                {ctxTokens != null ? formatTokensShort(ctxTokens) : '-'}
                {ctxWindow ? <span className="text-muted"> / {formatTokensShort(ctxWindow)}</span> : ''}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${barPct}%` }} />
            </div>
          </div>
          <div className="px-3 pt-2 pb-2 border-b border-white/5 space-y-1">
            <div className="text-muted text-[10px] uppercase tracking-wider font-semibold mb-1">Billed tokens</div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Input</span>
              <span>{formatTokensShort(stats.tokens.input)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Output</span>
              <span>{formatTokensShort(stats.tokens.output)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Cache read</span>
              <span>{formatTokensShort(stats.tokens.cacheRead)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Cache write</span>
              <span>{formatTokensShort(stats.tokens.cacheWrite)}</span>
            </div>
          </div>
          <div className="px-3 py-2 flex justify-between gap-3">
            <span className="text-muted">Total cost</span>
            <span>{fmtCost(stats.cost)}</span>
          </div>
        </div>,
        portalTarget,
      )}
    </>
  )
}

function formatTokensShort(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// -----------------------------------------------------------------------------
// Slash command popup
// -----------------------------------------------------------------------------

const SOURCE_LABEL: Record<AgentSlashCommand['source'], string> = {
  skill: 'Skill',
  prompt: 'Prompt',
  extension: 'Command',
}

const SOURCE_COLOR: Record<AgentSlashCommand['source'], string> = {
  skill: 'text-agent-light bg-agent/10',
  prompt: 'text-muted bg-white/5',
  extension: 'text-muted bg-white/5',
}

const TAB_BADGE: Record<'agents' | 'prompts' | 'skills', string> = {
  agents: 'Subagent',
  prompts: 'Prompt',
  skills: 'Skill',
}

const TAB_BADGE_COLOR: Record<'agents' | 'prompts' | 'skills', string> = {
  agents: 'text-muted bg-white/5',
  prompts: 'text-muted bg-white/5',
  skills: 'text-agent-light bg-agent/10',
}

function SlashPopup({
  commands,
  selectedIdx,
  onPick,
  onHover,
}: {
  commands: AgentSlashCommand[]
  selectedIdx: number
  onPick: (cmd: AgentSlashCommand) => void
  onHover: (idx: number) => void
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1.5 max-h-[240px] overflow-y-auto rounded-xl border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-20">
      {commands.map((cmd, i) => {
        const active = i === selectedIdx
        return (
          <button
            key={`${cmd.source}-${cmd.name}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(cmd) }}
            className={`w-full text-left px-3 py-2 flex items-start gap-2 ${
              active ? 'bg-white/10' : 'hover:bg-white/5'
            }`}
          >
            <span className={`shrink-0 mt-[1px] px-1.5 py-[1px] rounded text-[9px] uppercase tracking-wider font-semibold ${SOURCE_COLOR[cmd.source]}`}>
              {SOURCE_LABEL[cmd.source]}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-primary font-mono truncate">/{cmd.name}</div>
              {cmd.description && (
                <div className="text-[11px] text-muted truncate">{cmd.description}</div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Settings view — providers + installed slash commands (agents/prompts/skills)
// -----------------------------------------------------------------------------

function SettingsView({
  commands,
  workspaceId,
  cwd,
  scopedProviderId,
  availableModels,
  onBack,
  onRefresh,
}: {
  commands: AgentSlashCommand[]
  workspaceId: string
  cwd: string
  scopedProviderId?: string
  availableModels: Array<{ provider: string; model: string; label?: string }>
  onBack: () => void
  onRefresh: () => void
}) {
  const [activeSection, setActiveSection] = useState('providers')
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({})

  const scrollTo = useCallback((id: string) => {
    const el = sectionRefs.current[id]
    if (el && scrollRef.current) {
      const top = el.offsetTop - scrollRef.current.offsetTop
      scrollRef.current.scrollTo({ top, behavior: 'smooth' })
    }
  }, [])

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const handler = () => {
      const ids = ['providers', 'agents', 'prompts', 'skills', 'extensions']
      let closest = ids[0]
      let closestDist = Infinity
      for (const id of ids) {
        const el = sectionRefs.current[id]
        if (!el) continue
        const dist = Math.abs(el.offsetTop - container.offsetTop - container.scrollTop)
        if (dist < closestDist) { closestDist = dist; closest = id }
      }
      setActiveSection(closest)
    }
    container.addEventListener('scroll', handler, { passive: true })
    return () => container.removeEventListener('scroll', handler)
  }, [])

  useEffect(() => { if (scopedProviderId) scrollTo('providers') }, [scopedProviderId, scrollTo])

  const [agentFiles, setAgentFiles] = useState<Array<{ name: string; description?: string; path: string }>>([])
  const [promptFiles, setPromptFiles] = useState<Array<{ name: string; description?: string; path: string }>>([])
  const [skillFiles, setSkillFiles] = useState<Array<{ name: string; description?: string; path: string }>>([])
  const [creating, setCreating] = useState<'agents' | 'prompts' | 'skills' | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refreshAllFiles = useCallback(async () => {
    try {
      const [a, p, s] = await Promise.all([
        window.electronAPI.agentListSkillFiles(cwd, 'agents'),
        window.electronAPI.agentListSkillFiles(cwd, 'prompts'),
        window.electronAPI.agentListSkillFiles(cwd, 'skills'),
      ])
      setAgentFiles(a); setPromptFiles(p); setSkillFiles(s)
    } catch (err) { log.warn('[SettingsView] list failed', err) }
  }, [cwd])

  useEffect(() => { void refreshAllFiles() }, [refreshAllFiles])

  const packageSkills = useMemo(
    () => commands.filter((c) => c.source === 'skill' && !c.editable),
    [commands],
  )

  const handleCreate = async (kind: 'agents' | 'prompts' | 'skills'): Promise<void> => {
    setError(null)
    try {
      const created = await window.electronAPI.agentCreateSkill(cwd, kind, newName)
      setNewName(''); setCreating(null)
      await refreshAllFiles()
      onRefresh()
      useAppStore.getState().createEditor(workspaceId, created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleOpen = (filePath?: string): void => {
    if (!filePath) return
    useAppStore.getState().createEditor(workspaceId, filePath)
  }

  const handleDelete = async (kind: string, filePath?: string): Promise<void> => {
    if (!filePath) return
    if (!window.confirm(`Delete this ${kind.slice(0, -1)}?`)) return
    try {
      await window.electronAPI.agentDeleteSkillFile(cwd, filePath)
      await refreshAllFiles()
      onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const [refreshNonce, setRefreshNonce] = useState(0)

  const sections = ['Providers', 'Agents', 'Prompts', 'Skills', 'Extensions'] as const

  const renderSkillSection = (
    kind: 'agents' | 'prompts' | 'skills',
    files: Array<{ name: string; description?: string; path: string }>,
  ) => (
    <>
      <div className="flex items-center gap-2 mt-2">
        {creating !== kind && (
          <button
            onClick={() => { setCreating(kind); setError(null); setNewName('') }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-agent/20 hover:bg-agent/30 text-primary text-[12px]"
          >
            <Plus size={11} /> New {kind.slice(0, -1)}
          </button>
        )}
        <button
          onClick={() => window.electronAPI.agentOpenSkillsFolder(cwd, kind).catch(() => {})}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary text-[12px]"
        >
          <FolderOpen size={11} /> Open folder
        </button>
      </div>
      {creating === kind && (
        <div className="rounded-lg bg-white/[0.03] p-2 flex items-center gap-2 mt-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate(kind)
              if (e.key === 'Escape') { setCreating(null); setNewName(''); setError(null) }
            }}
            placeholder={`${kind.slice(0, -1)} name`}
            className="flex-1 bg-surface-3 border border-white/10 rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60 font-mono"
          />
          <button
            onClick={() => handleCreate(kind)}
            disabled={!newName.trim()}
            className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px]"
          >
            Create
          </button>
          <button
            onClick={() => { setCreating(null); setNewName(''); setError(null) }}
            className="px-2 py-1 rounded-md text-muted hover:text-primary text-[12px]"
          >
            Cancel
          </button>
        </div>
      )}
      {creating === kind && error && <div className="text-[12px] text-primary mt-1">{error}</div>}
      <div className="rounded-lg bg-white/[0.02] overflow-hidden mt-2">
        {files.length === 0 && (kind !== 'skills' || packageSkills.length === 0) ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted">
            No {kind} yet.
          </div>
        ) : (
          <>
            {files.map((f) => (
              <SkillRow
                key={f.path}
                name={f.name}
                description={f.description}
                badge={TAB_BADGE[kind]}
                badgeClass={TAB_BADGE_COLOR[kind]}
                filePath={f.path}
                deletable={true}
                onOpen={() => handleOpen(f.path)}
                onDelete={() => handleDelete(kind, f.path)}
              />
            ))}
            {kind === 'skills' && packageSkills.map((c) => (
              <SkillRow
                key={`pkg-${c.name}-${c.path ?? ''}`}
                name={c.name}
                description={c.description}
                badge="Built-in"
                badgeClass="text-muted bg-white/5"
                filePath={c.path}
                deletable={false}
                onOpen={() => handleOpen(c.path)}
                onDelete={() => {}}
              />
            ))}
          </>
        )}
      </div>
    </>
  )

  return (
    <div className="flex-1 flex min-h-0 text-primary">
      <div className="w-[110px] shrink-0 py-4 pl-3 pr-1 flex flex-col gap-0.5">
        <button onClick={onBack} className="text-[11px] text-muted hover:text-primary mb-3 text-left">
          ← Back
        </button>
        {sections.map((label) => {
          const id = label.toLowerCase()
          return (
            <button
              key={id}
              onClick={() => scrollTo(id)}
              className={`text-left px-2 py-1 rounded-md text-[12px] ${
                activeSection === id
                  ? 'text-primary bg-white/10'
                  : 'text-muted hover:text-primary'
              }`}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto py-4 pr-4 pl-2 min-h-0 space-y-8">
        <div ref={(el) => { sectionRefs.current['providers'] = el }}>
          <div className="text-[13px] font-semibold text-primary mb-3">Providers</div>
          <ProvidersView embedded scopedProviderId={scopedProviderId} availableModels={availableModels} />
        </div>

        <div ref={(el) => { sectionRefs.current['agents'] = el }}>
          <div className="text-[13px] font-semibold text-primary mb-1">Agents</div>
          {renderSkillSection('agents', agentFiles)}
        </div>

        <div ref={(el) => { sectionRefs.current['prompts'] = el }}>
          <div className="text-[13px] font-semibold text-primary mb-1">Prompts</div>
          {renderSkillSection('prompts', promptFiles)}
        </div>

        <div ref={(el) => { sectionRefs.current['skills'] = el }}>
          <div className="text-[13px] font-semibold text-primary mb-1">Skills</div>
          {renderSkillSection('skills', skillFiles)}
        </div>

        <div ref={(el) => { sectionRefs.current['extensions'] = el }}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] font-semibold text-primary">Extensions</div>
            <button
              onClick={() => setRefreshNonce((n) => n + 1)}
              className="p-1 rounded-md text-muted hover:text-primary hover:bg-white/5"
              title="Refresh"
            >
              <ArrowsClockwise size={12} />
            </button>
          </div>
          <ExtensionsTab cwd={cwd} refreshNonce={refreshNonce} />
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Extensions tab — Pi extension marketplace (install/uninstall pi packages)
// -----------------------------------------------------------------------------

interface MarketplaceCatalogEntry {
  name: string
  description: string
  author: string
  downloads: number
  type: string
  repoUrl: string
  requiresTerminal: boolean
}

interface InstalledExtensionEntry {
  name: string
  description?: string
  requiresTerminal: boolean
  path: string
}

const TERMINAL_TOOLTIP =
  'Some features in this extension require a terminal and are not supported in Cate yet.'

type MarketplaceSortValue = 'downloads' | 'recent' | 'name'

function ExtensionsTab({ cwd, refreshNonce = 0 }: { cwd: string; refreshNonce?: number }) {
  const [catalog, setCatalog] = useState<MarketplaceCatalogEntry[]>([])
  const [installed, setInstalled] = useState<InstalledExtensionEntry[]>([])
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<MarketplaceSortValue>('downloads')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [pending, setPending] = useState<Record<string, 'install' | 'uninstall' | undefined>>({})
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [browseLoading, setBrowseLoading] = useState(false)

  const refreshInstalled = useCallback(async () => {
    try {
      const list = await window.electronAPI.agentMarketplaceListInstalled(cwd)
      setInstalled(list)
    } catch (err) {
      log.warn('[ExtensionsTab] listInstalled failed', err)
    }
  }, [cwd])

  // Debounce the search input: typing waits 300ms before triggering a fetch.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQuery(queryInput.trim())
      setPage(1)
    }, 300)
    return () => { window.clearTimeout(handle) }
  }, [queryInput])

  // Initial installed list — independent of marketplace fetch. Re-runs when
  // the parent bumps `refreshNonce` (top-bar Refresh button).
  useEffect(() => { void refreshInstalled() }, [refreshInstalled, refreshNonce])

  // Marketplace fetch — re-runs on page/query/sort change, and on parent
  // refresh-nonce bumps from the top-bar Refresh button.
  useEffect(() => {
    let cancelled = false
    setBrowseLoading(true)
    void (async () => {
      try {
        const res = await window.electronAPI.agentMarketplaceList({ page, query, sort })
        if (cancelled) return
        setCatalog(res.entries)
        setTotalPages(res.totalPages)
      } catch (err) {
        if (!cancelled) {
          log.warn('[ExtensionsTab] marketplaceList failed', err)
          setCatalog([])
        }
      } finally {
        if (!cancelled) {
          setBrowseLoading(false)
          setLoaded(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [page, query, sort, refreshNonce])

  const installedNames = useMemo(
    () => new Set(installed.map((e) => e.name)),
    [installed],
  )

  // Backend handles search/sort/pagination — the renderer just renders.
  const filtered = catalog

  const setRowPending = (name: string, kind: 'install' | 'uninstall' | undefined): void => {
    setPending((prev) => {
      const next = { ...prev }
      if (kind) next[name] = kind
      else delete next[name]
      return next
    })
  }

  const handleInstall = async (name: string): Promise<void> => {
    setError(null)
    setRowPending(name, 'install')
    try {
      const res = await window.electronAPI.agentMarketplaceInstall(cwd, name)
      if (!res.ok) {
        setError(res.error ?? `Failed to install ${name}`)
      }
      await refreshInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRowPending(name, undefined)
    }
  }

  const handleUninstall = async (name: string): Promise<void> => {
    if (!window.confirm(`Uninstall ${name}?`)) return
    setError(null)
    setRowPending(name, 'uninstall')
    try {
      const res = await window.electronAPI.agentMarketplaceUninstall(cwd, name)
      if (!res.ok) {
        setError(res.error ?? `Failed to uninstall ${name}`)
      }
      await refreshInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRowPending(name, undefined)
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-100 whitespace-pre-wrap break-words">
          {error}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] uppercase tracking-wider text-muted">Installed</div>
        </div>
        <div className="rounded-lg bg-white/[0.02] overflow-hidden">
          {installed.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">
              No extensions installed.
            </div>
          ) : (
            installed.map((e) => (
              <ExtensionRow
                key={e.path}
                name={e.name}
                description={e.description}
                requiresTerminal={e.requiresTerminal}
                actionLabel="Uninstall"
                actionTone="danger"
                disabled={pending[e.name] !== undefined}
                busy={pending[e.name] === 'uninstall'}
                onAction={() => { void handleUninstall(e.name) }}
              />
            ))
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted">
            <span>Browse marketplace</span>
            {browseLoading && (
              <span
                aria-label="Loading"
                className="inline-block h-2.5 w-2.5 rounded-full border border-agent-light/40 border-t-agent-light animate-spin"
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as MarketplaceSortValue)
                setPage(1)
              }}
              className="bg-surface-3 border border-white/10 rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60"
            >
              <option value="downloads">Most downloads</option>
              <option value="recent">Recently published</option>
              <option value="name">A-Z</option>
            </select>
            <input
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Search..."
              className="bg-surface-3 border border-white/10 rounded-md px-2 py-1 text-[12px] text-primary outline-none focus:border-agent/60 w-[180px]"
            />
          </div>
        </div>
        <div className="rounded-lg bg-white/[0.02] overflow-hidden">
          {!loaded ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">
              {catalog.length === 0 ? 'Catalog unavailable.' : 'No matching extensions.'}
            </div>
          ) : (
            filtered.map((e) => {
              const isInstalled = installedNames.has(e.name)
              const busy = pending[e.name] === 'install'
              return (
                <ExtensionRow
                  key={e.name}
                  name={e.name}
                  description={e.description}
                  author={e.author}
                  downloads={e.downloads}
                  requiresTerminal={e.requiresTerminal}
                  actionLabel={isInstalled ? 'Installed' : 'Install'}
                  actionTone={isInstalled ? 'muted' : 'primary'}
                  disabled={isInstalled || pending[e.name] !== undefined}
                  busy={busy}
                  onAction={() => { if (!isInstalled) void handleInstall(e.name) }}
                />
              )
            })
          )}
        </div>
        {totalPages > 1 && (
          <div className="mt-2 flex items-center justify-center gap-3 text-[11px] text-muted">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={browseLoading || page <= 1}
              className="px-2 py-1 rounded-md bg-white/5 hover:bg-agent/20 hover:text-primary disabled:opacity-40 disabled:cursor-default disabled:hover:bg-white/5 disabled:hover:text-muted"
            >
              « Prev
            </button>
            <span>
              Page <span className="text-primary">{page}</span> of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={browseLoading || page >= totalPages}
              className="px-2 py-1 rounded-md bg-white/5 hover:bg-agent/20 hover:text-primary disabled:opacity-40 disabled:cursor-default disabled:hover:bg-white/5 disabled:hover:text-muted"
            >
              Next »
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ExtensionRow({
  name,
  description,
  author,
  downloads,
  requiresTerminal,
  actionLabel,
  actionTone,
  disabled,
  busy,
  onAction,
}: {
  name: string
  description?: string
  author?: string
  downloads?: number
  requiresTerminal: boolean
  actionLabel: string
  actionTone: 'primary' | 'danger' | 'muted'
  disabled: boolean
  busy: boolean
  onAction: () => void
}) {
  const toneClass =
    actionTone === 'primary'
      ? 'bg-agent hover:bg-agent-light text-white'
      : actionTone === 'danger'
      ? 'bg-white/5 hover:bg-rose-500/30 text-rose-100'
      : 'bg-white/5 text-muted'
  return (
    <div className="flex items-start gap-2 px-3 py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.04]">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12.5px] text-primary font-mono truncate">{name}</span>
          {requiresTerminal && (
            <span
              title={TERMINAL_TOOLTIP}
              className="shrink-0 px-1.5 py-[1px] rounded text-[9px] uppercase tracking-wider font-semibold text-agent-light bg-agent/15"
            >
              Terminal required
            </span>
          )}
        </div>
        {description && (
          <div className="text-[11px] text-muted truncate">{description}</div>
        )}
        {(author || (typeof downloads === 'number' && downloads > 0)) && (
          <div className="text-[10.5px] text-muted/80 mt-0.5">
            {author && <span>{author}</span>}
            {author && typeof downloads === 'number' && downloads > 0 ? <span> · </span> : null}
            {typeof downloads === 'number' && downloads > 0 ? <span>{downloads.toLocaleString()} downloads/mo</span> : null}
          </div>
        )}
      </div>
      <button
        onClick={onAction}
        disabled={disabled}
        className={`shrink-0 px-2.5 py-1 rounded-md text-[11px] disabled:opacity-50 disabled:cursor-default flex items-center gap-1.5 ${toneClass}`}
      >
        {busy && (
          <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
        )}
        {busy ? (actionLabel === 'Uninstall' ? 'Removing…' : 'Installing…') : actionLabel}
      </button>
    </div>
  )
}

function SkillRow({
  name,
  description,
  badge,
  badgeClass,
  filePath,
  deletable,
  onOpen,
  onDelete,
}: {
  name: string
  description?: string
  badge: string
  badgeClass: string
  filePath?: string
  deletable: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const clickable = !!filePath
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group flex items-center gap-2 px-3 py-2 border-b border-white/5 last:border-0 hover:bg-white/[0.04]"
    >
      <button
        onClick={onOpen}
        disabled={!clickable}
        className="flex-1 min-w-0 flex items-start gap-2 text-left disabled:cursor-default"
      >
        <span className={`shrink-0 mt-[1px] px-1.5 py-[1px] rounded text-[9px] uppercase tracking-wider font-semibold ${badgeClass}`}>
          {badge}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-primary font-mono">{name}</div>
          {description && (
            <div className="text-[11px] text-muted truncate">{description}</div>
          )}
        </div>
      </button>
      {hovered && deletable && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="p-1 rounded-md text-muted hover:text-primary hover:bg-white/10"
          title="Delete"
        >
          <Trash size={11} />
        </button>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Model picker dropdown
// -----------------------------------------------------------------------------

function ModelPicker({
  models,
  selected,
  onPick,
  onClose,
  onManage,
}: {
  models: Array<{ provider: string; model: string; label?: string }>
  selected: AgentModelRef | null
  onPick: (m: { provider: string; model: string }) => void
  onClose: () => void
  onManage: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) =>
      m.provider.toLowerCase().includes(q) ||
      m.model.toLowerCase().includes(q) ||
      (m.label?.toLowerCase().includes(q) ?? false),
    )
  }, [models, search])

  const grouped = useMemo(() => {
    const out = new Map<string, typeof models>()
    for (const m of filtered) {
      const arr = out.get(m.provider) ?? []
      arr.push(m)
      out.set(m.provider, arr)
    }
    return Array.from(out.entries())
  }, [filtered])

  // Collapse all providers by default except the one owning the current
  // selection. Searching auto-expands everything so matches are visible.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const all = new Set<string>()
    for (const m of models) all.add(m.provider)
    if (selected) all.delete(selected.provider)
    return all
  })
  const toggleProvider = (provider: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }
  const searching = search.trim().length > 0

  return (
    <div
      ref={wrapRef}
      className="absolute top-full left-0 mt-1 w-[280px] max-h-[360px] flex flex-col rounded-lg border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-20"
    >
      <div className="px-2 py-2 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/20 border border-white/5">
          <MagnifyingGlass size={11} className="text-muted shrink-0" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models"
            className="flex-1 bg-transparent text-[11px] text-primary placeholder:text-muted outline-none min-w-0"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
      {grouped.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-muted text-center">
          {models.length === 0 ? 'No models connected yet.' : 'No matches.'}
        </div>
      ) : (
        grouped.map(([provider, items]) => {
          const isCollapsed = !searching && collapsed.has(provider)
          return (
            <div key={provider}>
              <button
                type="button"
                onClick={() => toggleProvider(provider)}
                className="w-full flex items-center gap-1 px-3 py-1 text-[10px] uppercase tracking-wider text-muted/70 font-semibold sticky top-0 bg-surface-4/98 hover:text-primary"
              >
                {isCollapsed
                  ? <CaretRight size={9} className="shrink-0" />
                  : <CaretDown size={9} className="shrink-0" />}
                <span className="flex-1 text-left">{provider}</span>
                <span className="text-muted/50 normal-case tracking-normal">{items.length}</span>
              </button>
              {!isCollapsed && items.map((m) => {
                const isSelected =
                  selected?.provider === m.provider && selected?.model === m.model
                return (
                  <button
                    key={`${m.provider}:${m.model}`}
                    onClick={() => onPick(m)}
                    className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 ${
                      isSelected ? 'bg-white/10 text-primary' : 'text-primary hover:bg-white/5'
                    }`}
                  >
                    <span className="truncate flex-1">{m.label ?? m.model}</span>
                    {isSelected && <CheckCircle size={10} weight="fill" className="text-agent-light" />}
                  </button>
                )
              })}
            </div>
          )
        })
      )}
      </div>
      <div className="border-t border-white/10 shrink-0">
        <button
          onClick={onManage}
          className="w-full text-left px-3 py-1.5 text-[12px] text-agent-light hover:bg-white/5"
        >
          Manage providers…
        </button>
      </div>
    </div>
  )
}
