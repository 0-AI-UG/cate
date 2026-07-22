// =============================================================================
// AgentPanel — Pi coding-agent chat panel.
//
// Layout (Codex-style):
//   ┌──────────────┬───────────────────────────────────────────────┐
//   │  Sidebar     │           Welcome / thread                    │
//   │  • New chat  │ ───────────────────────────────────────────── │
//   │  • Recent    │  Composer (model · worktree · send)           │
//   └──────────────┴───────────────────────────────────────────────┘
//
// The composer is the shared ChatComposer (src/renderer/chat), the same one the
// Cate Agent sidebar renders, so both surfaces carry one set of controls. Model
// and worktree live on it rather than in a header; the header row only appears
// when it has something to hold (the sidebar toggle, or the settings title).
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
  Sidebar as SidebarIcon,
  Gear,
} from '@phosphor-icons/react'
import log from '../../renderer/lib/logger'
import type { PanelProps } from '../../renderer/panels/types'
import { useAppStore } from '../../renderer/stores/appStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { useAgentStore } from './agentStore'
import { agentClient } from './agentClient'
import {
  getAgentPanelSession,
  saveAgentPanelSession,
  disposeAgentChats,
  disposeCodingChat,
  resolvePanelChats,
  beginAgentCreate,
  endAgentCreate,
  type OpenChat,
} from './agentSessionRegistry'
import { useChatsStore } from '../../renderer/stores/chatsStore'
import { AgentSidebar } from './AgentSidebar'
import { CodingChatView } from './CodingChatView'
import { useWorktrees } from '../../renderer/stores/useWorktrees'
import { useWorktreeActions } from '../../renderer/stores/useWorktreeActions'
import type { PrListItem } from '../../renderer/sidebar/CreateWorktreeForm'
import { SettingsView } from './AgentSettingsView'
import type {
  AgentModelRef,
  AgentRpcState,
  AgentSessionListEntry,
  AgentSlashCommand,
} from '../../shared/types'
import type { AgentMessage as StoreMessage } from './agentStore'
import { loadDefaultModel } from './agentModelPrefs'
import { resolveWorktree } from '../../shared/worktrees'

// -----------------------------------------------------------------------------
// Worktree switch gate
//
// The panel's worktree IS its cwd, and pi's cwd is fixed at spawn — switching
// disposes every open chat and reopens a single fresh one in the new checkout
// (see the reinit effect below). On the canvas that lived behind a context
// menu; in the composer it's one click, so ask first whenever there is real
// work to lose. Uses the same native-dialog pattern as the other close gates
// (confirmCloseTerminal / confirmCloseDirty).
// -----------------------------------------------------------------------------

/** Re-tag `panelId` to `target` behind the confirm gate, writing through the
 *  same setPanelWorktreeId action the canvas WorktreePill uses. Returns true
 *  when the switch happened. */
export async function switchAgentWorktree(opts: {
  workspaceId: string
  panelId: string
  target: { id: string; path: string; label?: string; branch?: string }
  /** The panel's current working directory. */
  cwd: string
  /** Chats currently open in the panel. */
  chatCount: number
  /** Whether the active chat has any messages. */
  hasMessages: boolean
}): Promise<boolean> {
  const { workspaceId, panelId, target } = opts
  // Same checkout (e.g. picking the row the pill already falls back to): the
  // reinit never runs, so there is nothing to confirm.
  const destructive = target.path !== opts.cwd && (opts.chatCount > 1 || opts.hasMessages)
  if (destructive && window.electronAPI?.confirmSwitchAgentWorktree) {
    const choice = await window.electronAPI.confirmSwitchAgentWorktree({
      chatCount: opts.chatCount,
      hasMessages: opts.hasMessages,
      worktreeName: target.label || target.branch || undefined,
    })
    if (choice !== 'switch') return false
  }
  useAppStore.getState().setPanelWorktreeId(workspaceId, panelId, target.id)
  return true
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function AgentPanel({ panelId, workspaceId }: PanelProps) {
  const workspace = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId))
  // If this panel is tagged with a worktree, prefer its path so pi spawns
  // inside that parallel checkout instead of the workspace's primary root.
  const panelState = workspace?.panels[panelId]
  const taggedWorktree = resolveWorktree(panelState?.worktreeId, workspace?.worktrees)
  const cwd = taggedWorktree?.path ?? workspace?.rootPath ?? ''

  // Worktree picker in the composer. Same read-time join and same create path
  // every other worktree surface uses; orphans (metadata whose checkout is
  // gone) are not pickable. The selection writes through setPanelWorktreeId —
  // the very same action the canvas WorktreePill uses.
  const rootPath = workspace?.rootPath ?? ''
  const joinedWorktrees = useWorktrees(rootPath, workspaceId)
  const worktrees = useMemo(() => joinedWorktrees.filter((w) => !w.isOrphan), [joinedWorktrees])
  const { createWorktree, checkoutPr } = useWorktreeActions(rootPath, workspaceId)

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
  /** Composer model menu, held here so the readiness banner can open it. */
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
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

  // The active chat's `running` flag drives the panel's status mirror and the
  // after-turn chat re-list. Everything else the active chat's slice holds is
  // owned by CodingChatView, which subscribes to the same slice itself.
  const running = useAgentStore((s) =>
    activeAgentKey ? s.panels[activeAgentKey]?.running ?? false : false,
  )
  const [availableModels, setAvailableModels] = useState<
    Array<{ provider: string; model: string; label?: string }>
  >([])
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  /** Pi-session entries on disk for this workspace's cwd. Sidebar source of
   *  truth — no localStorage shadow list. */
  const [chats, setChats] = useState<AgentSessionListEntry[]>([])
  const [chatSearch, setChatSearch] = useState('')
  const [commands, setCommands] = useState<AgentSlashCommand[]>([])

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
    // Pi just reported this chat's on-disk file — persist it onto the durable
    // coding chat so a later mount can resume it after a restart.
    const entry = openChatsRef.current.find((c) => c.agentKey === key)
    if (entry && entry.sessionFile !== file) {
      useChatsStore.getState().updateCodingChat(rootPath, entry.chatId, { sessionFile: file })
    }
    setOpenChats((prev) => {
      const idx = prev.findIndex((c) => c.agentKey === key)
      if (idx < 0) return prev
      if (prev[idx].sessionFile === file) return prev
      const next = prev.slice()
      next[idx] = { ...next[idx], sessionFile: file }
      return next
    })
  }, [rootPath])

  // ---------------------------------------------------------------------------
  // Model list refresh (provider connection/health is owned by the readiness store)
  // ---------------------------------------------------------------------------

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
  // auth.json is mirrored into live sessions; re-fetch the model list so the
  // picker and auto-pick reflect newly-connected providers without waiting for
  // the next turn. (The readiness store handles provider status itself.)
  useEffect(() => {
    if (!window.electronAPI?.onAuthChanged) return
    return window.electronAPI.onAuthChanged(() => { void refreshModels() })
  }, [refreshModels])

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
    // Dedup: if a create for this key is already in flight (a sibling panel
    // resolving the same durable chat), skip — the in-flight one brings the
    // shared slice to ready. Main is idempotent per key too (belt and suspenders).
    if (!beginAgentCreate(key)) return
    markReady(key, false)
    try {
      const res = await agentClient.create({
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
    } finally {
      endAgentCreate(key)
    }
  }, [workspaceId, cwd, refreshCommands, markReady])

  // Open the most-recent on-disk session for the current cwd as the panel's sole
  // chat (or a fresh chat if the checkout has none). Shared by the mount effect
  // and the worktree-switch reinit below; both pass a `signal` so they can abort
  // the in-flight startup if the panel unmounts or the cwd changes again.
  const openInitialChat = useCallback(async (signal: { cancelled: boolean }) => {
    const myGen = ++openGenRef.current
    // The workspace durably owns coding chats — load them before resolving so we
    // adopt existing records rather than minting rivals that clobber them.
    if (rootPath) await useChatsStore.getState().loadChats(rootPath)
    if (signal.cancelled || myGen !== openGenRef.current) return

    // Resolve the durable coding chats this checkout owns. Live ones (pi + slice
    // survived a panel close, or a sibling panel started them) are adopted by
    // reference; dead ones are resumed under their EXISTING agentKey so two panels
    // resolving the same session converge on ONE pi instead of stranding rivals.
    const plan = resolvePanelChats(rootPath, panelState?.worktreeId)
    if (plan.refs.length > 0) {
      const chatsSt = useChatsStore.getState()
      // Prime each dead chat's slice (model + transcript) before its pi starts.
      for (const ref of plan.toResume) {
        const rec = chatsSt.getChat(rootPath, ref.chatId)
        useAgentStore.getState().init(ref.agentKey)
        if (rec?.model) useAgentStore.getState().setModel(ref.agentKey, rec.model)
        if (ref.sessionFile) {
          try {
            const transcript = await window.electronAPI.agentLoadSessionMessages(ref.sessionFile)
            if (signal.cancelled || myGen !== openGenRef.current) return
            useAgentStore.getState().loadMessages(ref.agentKey, transcript as StoreMessage[])
          } catch (err) { log.warn('[AgentPanel] load transcript failed', err) }
        }
      }
      if (signal.cancelled || myGen !== openGenRef.current) return
      setOpenChats(plan.refs)
      const activeKey = plan.refs[plan.refs.length - 1].agentKey
      setActiveAgentKey(activeKey)
      // Resume the dead ones under their recorded agentKey (createAgent is deduped
      // + main-idempotent, so racing a sibling panel on the same key is a no-op).
      for (const ref of plan.toResume) {
        if (signal.cancelled || myGen !== openGenRef.current) return
        const rec = chatsSt.getChat(rootPath, ref.chatId)
        await createAgent(ref.agentKey, rec?.model ?? null, ref.sessionFile ?? undefined)
      }
      void refreshCommands(activeKey)
      return
    }

    // No durable coding chat for this checkout. Fall back to pi's on-disk session
    // list and adopt the most recent (or open a fresh chat), MINTING a new agentKey
    // and registering a durable record so it outlives the panel.
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
    const chatId = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: key,
      sessionFile: resume?.path ?? null,
      worktreeId: panelState?.worktreeId,
      model: initialModel ?? undefined,
      title: resume?.title ?? 'New chat',
    }).id
    // Set state BEFORE creating pi so this key is recorded in openChats (and
    // mirrored to the session registry) before any teardown could run.
    setOpenChats([{ agentKey: key, sessionFile: resume?.path ?? null, chatId }])
    setActiveAgentKey(key)
    await createAgent(key, initialModel, resume?.path)
  }, [cwd, rootPath, panelState?.worktreeId, newAgentKey, createAgent, refreshCommands])

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

    // No registry entry (fresh panel, or reopened after a close). openInitialChat
    // resolves the durable coding chats this checkout owns — adopting live ones by
    // reference and resuming dead ones under their recorded agentKey — or opens a
    // fresh chat when the checkout has none.
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
    // disposeAgentChats drops the pi + slice; we also drop the durable records so
    // .cate/chats.json doesn't accumulate stale coding chats (dead agentKey, old
    // worktreeId) on every switch. The on-disk pi .jsonl survives for manual
    // resume via the recents list, so no history is lost.
    const leaving = openChatsRef.current
    disposeAgentChats(leaving)
    for (const c of leaving) useChatsStore.getState().removeChat(rootPath, c.chatId)
    readyByKey.current = {}
    setOpenChats([])
    setActiveAgentKey(null)
    setReadyTick((n) => n + 1)

    const signal = { cancelled: false }
    void openInitialChat(signal)
    return () => { signal.cancelled = true }
  }, [cwd, rootPath, openInitialChat])

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

  // The active chat's default-model pick (once auth resolves) now lives in
  // CodingChatView, which owns the active chat's selected model.

  // Pi writes session entries to disk automatically; no renderer-side persist
  // needed here. The sidebar refreshes when `running` flips false.

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  // Re-tag this panel's worktree — i.e. move the agent's working directory. The
  // cwd effect below does the rest (dispose the old checkout's chats, reopen in
  // the new one), which is destructive, so gate it behind a confirm whenever
  // there is real work in the panel.
  const handlePickWorktree = useCallback(async (id: string) => {
    const target = worktrees.find((w) => w.id === id)
    if (!target) return
    await switchAgentWorktree({
      workspaceId,
      panelId,
      target,
      cwd,
      chatCount: openChatsRef.current.length,
      hasMessages: (useAgentStore.getState().panels[activeAgentKey ?? '']?.messages.length ?? 0) > 0,
    })
  }, [worktrees, cwd, activeAgentKey, workspaceId, panelId])

  const handleCreateWorktree = useCallback(async (name: string, baseRef?: string) => {
    const meta = await createWorktree(name, baseRef)
    return meta?.id ?? null
  }, [createWorktree])

  const handleCheckoutPr = useCallback(async (pr: PrListItem) => {
    const meta = await checkoutPr(pr)
    return meta?.id ?? null
  }, [checkoutPr])

  const handleNewChat = useCallback(async () => {
    const myGen = ++openGenRef.current
    const key = newAgentKey()
    useAgentStore.getState().init(key)
    // New chats always start with the user-configured default. If no default
    // is set, fall through to the default-pick effect (first available).
    const model = loadDefaultModel()
    if (model) useAgentStore.getState().setModel(key, model)
    if (rootPath) await useChatsStore.getState().loadChats(rootPath)
    const chatId = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: key,
      sessionFile: null,
      worktreeId: panelState?.worktreeId,
      model: model ?? undefined,
      title: 'New chat',
    }).id
    setOpenChats((prev) => [...prev, { agentKey: key, sessionFile: null, chatId }])
    setActiveAgentKey(key)
    setView('chat')
    if (myGen !== openGenRef.current) return
    await createAgent(key, model)
    if (myGen !== openGenRef.current) return
    void refreshChats()
  }, [createAgent, refreshChats, newAgentKey, rootPath, panelState?.worktreeId])

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
    // Register (or reuse, deduped by sessionFile) the durable coding chat.
    const chatsSt = useChatsStore.getState()
    const existingChat = chatsSt.getChatsByMode(rootPath, 'coding').find((c) => c.sessionFile === sessionFile)
    let chatId: string
    if (existingChat) {
      chatId = existingChat.id
      chatsSt.updateCodingChat(rootPath, chatId, { agentKey: key, ...(model ? { model } : {}) })
    } else {
      chatId = chatsSt.createCodingChat(rootPath, {
        agentKey: key,
        sessionFile,
        worktreeId: panelState?.worktreeId,
        model: model ?? undefined,
        title: entry?.title ?? 'New chat',
      }).id
    }
    setOpenChats((prev) => [...prev, { agentKey: key, sessionFile, chatId }])
    setActiveAgentKey(key)
    await createAgent(key, model, sessionFile)
  }, [openChats, chats, createAgent, newAgentKey, rootPath, panelState?.worktreeId])

  const handleCloseChat = useCallback((key: string) => {
    // Per-tab close. Under the shared/worktree-scoped model a panel shows EVERY
    // durable coding chat for its checkout, so a reference-only close would just
    // reappear on the next resolve. Closing therefore removes the durable record
    // and disposes its pi + slice (disposeCodingChat) — but keeps pi's on-disk
    // .jsonl, so the thread stays resumable from the recents list. Deleting the
    // file too is handleDeleteChat's job.
    const entry = openChatsRef.current.find((c) => c.agentKey === key)
    readyByKey.current[key] = false
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
    if (entry) disposeCodingChat(rootPath, entry.chatId)
    else {
      // No durable record for this key (shouldn't happen) — still tear down the
      // pi + slice so nothing is stranded.
      agentClient.dispose(key).catch(() => { /* */ })
      useAgentStore.getState().dispose(key)
    }
  }, [activeAgentKey, handleNewChat, rootPath])

  const handleDeleteChat = useCallback(async (sessionFile: string) => {
    // If this chat is currently open in the panel, dispose its pi session and
    // drop it from openChats first. If it was active, fall back to another
    // open chat — or auto-spawn a fresh one so the panel is never empty.
    const open = openChatsRef.current.find((c) => c.sessionFile === sessionFile)
    if (open) handleCloseChat(open.agentKey)
    // Explicit delete is the ONLY disposer: drop the durable coding chat (disposes
    // its pi + store slice if still live) alongside deleting pi's on-disk session.
    const durable = useChatsStore.getState().getChatsByMode(rootPath, 'coding').find((c) => c.sessionFile === sessionFile)
    if (durable) disposeCodingChat(rootPath, durable.id)
    try {
      await window.electronAPI.agentDeleteSession(sessionFile)
    } catch (err) {
      log.warn('[AgentPanel] deleteSession failed', err)
    }
    await refreshChats()
  }, [refreshChats, handleCloseChat, rootPath])

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

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
  // Background session-file polling
  //
  // Learn the on-disk session file for EVERY open chat, not just the active one.
  // Pi assigns a file on the first turn; CodingChatView's stats poll only runs
  // for the active chat, so a background chat would keep sessionFile:null and
  // reopening its sidebar row would take the create-branch and spawn a SECOND pi
  // bound to the same file the still-running original owns. Poll any ready chat
  // missing a file (cheap get_state) so handleOpenChat always matches the live
  // chat. This spans all open chats, so it stays panel-owned. It also covers the
  // active chat, keeping its openChats/durable sessionFile in sync.
  // ---------------------------------------------------------------------------
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
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="relative w-full h-full flex bg-surface-4 text-primary min-h-0 overflow-hidden">
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
        {/* Header — only the sidebar toggle (when collapsed) and the current-view
         *  title. Model, worktree and session controls live in the composer, so
         *  in the chat view with the sidebar open there is nothing left to show:
         *  drop the row entirely rather than reserve 40px of empty chrome. */}
        {(!sidebarOpen || view === 'settings') && (
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

            {view === 'settings' && (
              <div className="px-2 py-1 text-[12px] font-medium text-primary flex items-center gap-1.5">
                <Gear size={12} />
                Settings
              </div>
            )}
          </div>
        )}

        {/* Body */}
        {view === 'settings' ? (
          <SettingsView
            workspaceId={workspaceId}
            cwd={cwd}
            onBack={() => setView('chat')}
            onRefresh={() => { if (activeAgentKey) void refreshCommands(activeAgentKey) }}
          />
        ) : (
          <CodingChatView
            agentKey={activeAgentKey}
            workspaceId={workspaceId}
            rootPath={rootPath}
            sessionReady={sessionReady}
            readyTick={readyTick}
            onSessionFile={updateChatSessionFile}
            commands={commands}
            onSlashOpen={handleSlashOpen}
            modelPickerOpen={modelPickerOpen}
            onModelPickerOpenChange={setModelPickerOpen}
            composerExtras={{
              availableModels,
              refreshModels,
              openProviderSettings,
              worktrees,
              selectedWorktreeId: panelState?.worktreeId ?? null,
              onPickWorktree: (id) => { void handlePickWorktree(id) },
              onCreateWorktree: handleCreateWorktree,
              onCheckoutPr: handleCheckoutPr,
            }}
          />
        )}
      </div>
    </div>
  )
}
