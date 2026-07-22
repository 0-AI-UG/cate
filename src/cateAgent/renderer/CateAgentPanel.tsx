// =============================================================================
// CateAgentPanel — Pi coding-agent chat panel.
//
// Layout (Codex-style):
//   ┌──────────────┬───────────────────────────────────────────────┐
//   │  Sidebar     │           Welcome / thread                    │
//   │  • New chat  │ ───────────────────────────────────────────── │
//   │  • Chats     │  Composer (model · worktree · send)           │
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
// Chats are durable, workspace-owned records in chatsStore (.cate/chats.json),
// not the panel's own state — they outlive the panel and are the draggable unit
// of work. Each record carries a `mode`: a 'coding' chat references a pi session
// (agentKey + sessionFile) rendered by CodingChatView; a 'loop' (Cate Agent) chat
// is hosted through an additive branch that renders LoopChatView instead. The
// sidebar lists the durable chats this panel holds open for its checkout (the
// same records — and titles — every other chat surface shows), NOT pi's on-disk
// session history; opening a coding row just re-points the active pi by key.
// =============================================================================

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sidebar as SidebarIcon,
  Gear,
} from '@phosphor-icons/react'
import log from '../../renderer/lib/logger'
import type { PanelProps } from '../../renderer/panels/types'
import { useAppStore } from '../../renderer/stores/appStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { useStatusStore } from '../../renderer/stores/statusStore'
import { useCodingStore } from './codingStore'
import { codingClient } from './codingClient'
import {
  getCateAgentPanelSession,
  saveCateAgentPanelSession,
  disposeCodingChats,
  disposeCodingChat,
  resolvePanelChats,
  resumeCodingChat,
  createCodingChatSession,
  type OpenChat,
} from './codingSessionRegistry'
import { useChatsStore, chatMode } from '../../renderer/stores/chatsStore'
import { CateAgentPanelSidebar } from './CateAgentPanelSidebar'
import { CodingChatView } from './CodingChatView'
import { useComposerModels } from '../../renderer/chat/useComposerModels'
import { useComposerWorktrees } from '../../renderer/chat/useComposerWorktrees'
import { SettingsView } from './CateAgentSettingsView'
import type {
  CodingRpcState,
  CodingSlashCommand,
  Chat,
} from '../../shared/types'
import { loadDefaultModel } from './codingModelPrefs'
import { resolveWorktree } from '../../shared/worktrees'

// Loop (Cate Agent) chats can also be hosted in this panel. LoopChatView
// transitively pulls the loop runtime (cateAgentController → xterm) via
// CateAgentComposer; loading it lazily keeps the terminal off the coding panel's
// static bundle (the panel today imports no xterm — preserve that).
const LoopChatView = lazy(() => import('./LoopChatView'))

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
export async function switchCateAgentWorktree(opts: {
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

export default function CateAgentPanel({ panelId, workspaceId }: PanelProps) {
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
  const { worktrees, onCreateWorktree, onCheckoutPr } = useComposerWorktrees({ rootPath, workspaceId })

  // ---------------------------------------------------------------------------
  // Multi-chat session bookkeeping.
  //
  // One CateAgentPanel hosts N concurrent pi chat sessions. Each chat has its own
  // pi process (keyed by `agentKey`) and its own slice in useCodingStore. The
  // UI renders the active chat's slice; background chats keep streaming events
  // into their slices so switching back resumes mid-turn with no state loss.
  //
  // The React `panelId` prop is the dock-panel identity — used only to
  // namespace generated agent keys (so distinct CateAgentPanel instances never
  // collide) and as the mount/unmount anchor for cleanup.
  // ---------------------------------------------------------------------------
  const [openChats, setOpenChats] = useState<OpenChat[]>([])
  const [activeAgentKey, setActiveAgentKey] = useState<string | null>(null)
  // Additive loop-chat branch: when set, the body renders LoopChatView for this
  // chat instead of the coding CodingChatView. The coding chats above stay alive
  // and their lifecycle effects keep running — this only swaps what the body
  // shows, it never tears anything coding down.
  const [activeLoopChatId, setActiveLoopChatId] = useState<string | null>(null)
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
  const sessionReady = activeAgentKey
    ? !!readyByKey.current[activeAgentKey]
    : false

  // The active chat's `running` flag drives the panel's status mirror and the
  // after-turn chat re-list. Everything else the active chat's slice holds is
  // owned by CodingChatView, which subscribes to the same slice itself.
  const running = useCodingStore((s) =>
    activeAgentKey ? s.panels[activeAgentKey]?.running ?? false : false,
  )
  // The provider-grouped model list (shared with every other chat composer):
  // fetched on mount, refreshed when the model menu opens or auth changes.
  const { models: availableModels, refreshModels } = useComposerModels()
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const [commands, setCommands] = useState<CodingSlashCommand[]>([])

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

  // Credentials can change anywhere (main Settings → Providers, another window,
  // a token refresh). The main process broadcasts AUTH_CHANGED once the shared
  // auth.json is mirrored into live sessions; re-fetch the model list so the
  // picker and auto-pick reflect newly-connected providers without waiting for
  // the next turn. (The readiness store handles provider status itself.)
  useEffect(() => {
    if (!window.electronAPI?.onAuthChanged) return
    return window.electronAPI.onAuthChanged(() => { refreshModels() })
  }, [refreshModels])

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
  // Slash-command list — only available once a chat's pi RPC session is up.
  // ---------------------------------------------------------------------------

  const refreshCommands = useCallback(async (key: string) => {
    if (!key) return
    try {
      const cmds = await window.electronAPI.agentGetCommands(key)
      setCommands(cmds)
    } catch (err) {
      log.warn('[CateAgentPanel] getCommands failed', err)
    }
  }, [])

  const handleNewChat = useCallback(async () => {
    const myGen = ++openGenRef.current
    // New chats always start with the user-configured default. If no default
    // is set, fall through to the default-pick effect (first available).
    const model = loadDefaultModel()
    // The workspace durably owns coding chats — load before minting so we append
    // to the on-disk list rather than clobber it.
    if (rootPath) await useChatsStore.getState().loadChats(rootPath)
    if (myGen !== openGenRef.current) return
    // Mint the durable chat + start its pi through the shared primitive; the
    // panel keeps ownership of the surrounding bookkeeping (open-chats list,
    // active key, per-chat readiness, command refresh).
    const { chatId, agentKey: key, ready } = createCodingChatSession(rootPath, {
      workspaceId,
      cwd,
      worktreeId: panelState?.worktreeId,
      model,
      title: 'New chat',
      namespace: panelId,
    })
    setOpenChats((prev) => [...prev, { agentKey: key, sessionFile: null, chatId }])
    setActiveAgentKey(key)
    setView('chat')
    void ready.then((ok) => {
      if (myGen !== openGenRef.current) return
      markReady(key, ok)
      if (ok) void refreshCommands(key)
    })
  }, [refreshCommands, markReady, rootPath, workspaceId, cwd, panelId, panelState?.worktreeId])

  // Adopt/resume the durable coding chats this checkout owns, or open a fresh chat
  // when it owns none. Shared by the mount effect and the worktree-switch reinit
  // below; both pass a `signal` so they can abort the in-flight startup if the
  // panel unmounts or the cwd changes again.
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
      setOpenChats(plan.refs)
      const activeKey = plan.refs[plan.refs.length - 1].agentKey
      setActiveAgentKey(activeKey)
      // Resume each dead chat through the shared primitive: init its slice, replay
      // the on-disk transcript, and respawn pi under its EXISTING agentKey (deduped
      // + main-idempotent, so racing a sibling panel on the same key is a no-op).
      // Readiness (markReady) + per-chat command refresh stay panel-local around it.
      for (const ref of plan.toResume) {
        if (signal.cancelled || myGen !== openGenRef.current) return
        markReady(ref.agentKey, false)
        const ok = await resumeCodingChat(rootPath, ref.chatId, cwd, workspaceId, signal)
        if (signal.cancelled || myGen !== openGenRef.current) return
        markReady(ref.agentKey, ok)
        if (ok) void refreshCommands(ref.agentKey)
      }
      void refreshCommands(activeKey)
      return
    }

    // The checkout owns no durable coding chat — open a brand-new empty one.
    if (signal.cancelled || myGen !== openGenRef.current) return
    await handleNewChat()
  }, [rootPath, panelState?.worktreeId, cwd, workspaceId, handleNewChat, refreshCommands, markReady])

  // Mount: re-adopt this panel's live chats if a prior mount left them in the
  // session registry (e.g. the panel was dragged between a canvas node and a
  // dock zone, which unmounts it here and remounts it in another subtree).
  // Otherwise resolve the checkout's durable coding chats (or a fresh one).
  //
  // Unmount is deliberately NOT a teardown: the pi processes + store slices are
  // keyed by agentKey and must survive a remount. Genuine teardown runs from
  // the appStore close paths via disposeCateAgentPanel().
  useEffect(() => {
    const saved = getCateAgentPanelSession(panelId)
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
    // Seeded panel (a chat dragged onto the canvas / a dock zone): after the
    // checkout's chats are resolved, make the dragged chat the active one. A loop
    // chat flips the body; a coding chat is already adopted by openInitialChat
    // (its worktree is this panel's), so we just re-point the active key. A
    // now-deleted seed id falls through to the default openInitialChat left open.
    const seedChatId = panelState?.initialChatId
    void openInitialChat(signal).then(() => {
      if (signal.cancelled || !seedChatId) return
      const chat = useChatsStore.getState().getChat(rootPath, seedChatId)
      if (!chat) return
      if (chatMode(chat) === 'loop') setActiveLoopChatId(seedChatId)
      else if (chat.agentKey) setActiveAgentKey(chat.agentKey)
    })

    return () => {
      // Cancel any in-flight startup; do NOT dispose pi/store here — the panel
      // may just be moving between canvas and dock. Teardown is centralized in
      // disposeCateAgentPanel(), called from the appStore close paths.
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
    // disposeCodingChats drops the pi + slice; we also drop the durable records so
    // .cate/chats.json doesn't accumulate stale coding chats (dead agentKey, old
    // worktreeId) on every switch. The on-disk pi .jsonl survives on disk.
    const leaving = openChatsRef.current
    disposeCodingChats(leaving)
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
    saveCateAgentPanelSession(panelId, {
      openChats,
      activeAgentKey,
      readyByKey: readyByKey.current,
    })
  }, [panelId, openChats, activeAgentKey, readyTick])

  // The active chat's default-model pick (once auth resolves) now lives in
  // CodingChatView, which owns the active chat's selected model.

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
    await switchCateAgentWorktree({
      workspaceId,
      panelId,
      target,
      cwd,
      chatCount: openChatsRef.current.length,
      hasMessages: (useCodingStore.getState().panels[activeAgentKey ?? '']?.messages.length ?? 0) > 0,
    })
  }, [worktrees, cwd, activeAgentKey, workspaceId, panelId])

  const handleOpenCodingChat = useCallback((chatId: string) => {
    // The chat is already in openChats (the sidebar list is derived from it), so
    // switching is just re-pointing the active key. Picking a coding row also
    // flips the body back from any active loop chat.
    setActiveLoopChatId(null)
    const entry = openChatsRef.current.find((c) => c.chatId === chatId)
    if (entry) {
      setActiveAgentKey(entry.agentKey)
      setView('chat')
    }
  }, [])

  const handleCloseChat = useCallback((key: string) => {
    // Per-tab close. Under the shared/worktree-scoped model a panel shows EVERY
    // durable coding chat for its checkout, so a reference-only close would just
    // reappear on the next resolve. Closing therefore removes the durable record
    // and disposes its pi + slice (disposeCodingChat). Pi's on-disk .jsonl is left
    // in place, but is no longer surfaced for resume by this panel.
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
      codingClient.dispose(key).catch(() => { /* */ })
      useCodingStore.getState().dispose(key)
    }
  }, [activeAgentKey, handleNewChat, rootPath])

  const handleDeleteCodingChat = useCallback((chatId: string) => {
    // Deleting a coding row IS the per-tab close: it disposes the chat's pi +
    // slice and drops the durable record (handleCloseChat → disposeCodingChat),
    // reassigning the active chat (or minting a fresh one) so the panel is never
    // empty.
    const entry = openChatsRef.current.find((c) => c.chatId === chatId)
    if (entry) handleCloseChat(entry.agentKey)
  }, [handleCloseChat])

  // ---------------------------------------------------------------------------
  // Loop-chat actions (additive — separate from the coding pi lifecycle above).
  //
  // Loop chats are durable chatsStore records driven by cateAgentController, not
  // pi sessions. The orchestrator pi session starts lazily on first send, so a
  // brand-new loop chat just needs its record minted and set active — LoopChatView
  // renders the empty state + composer until then.
  // ---------------------------------------------------------------------------

  const handleNewCodingChat = useCallback(() => {
    setActiveLoopChatId(null)
    void handleNewChat()
  }, [handleNewChat])

  const handleNewLoopChat = useCallback(async () => {
    // Load first, like handleNewChat: minting before the mount's in-flight
    // projectChatsLoad settles lets that load overwrite the fresh record.
    await useChatsStore.getState().loadChats(rootPath)
    const chat = useChatsStore.getState().createChat(rootPath, 'New chat')
    setActiveLoopChatId(chat.id)
    setView('chat')
  }, [rootPath])

  const handleOpenLoopChat = useCallback((chatId: string) => {
    setActiveLoopChatId(chatId)
    setView('chat')
  }, [])

  const handleDeleteLoopChat = useCallback((chatId: string) => {
    // cateAgentController transitively pulls the loop runtime (xterm); import it
    // lazily so the coding panel's static bundle stays terminal-free. closeChat is
    // the loop delete path — it prompts when there's unmerged work, tears down the
    // orchestrator + run work, and drops the durable record. Only drop the panel's
    // active-loop view if the delete actually happened (Cancel keeps the chat).
    void import('./cateAgentController').then(async ({ cateAgentController }) => {
      const deleted = await cateAgentController.closeChat(workspaceId, rootPath, chatId)
      if (deleted && activeLoopChatId === chatId) setActiveLoopChatId(null)
    })
  }, [activeLoopChatId, workspaceId, rootPath])

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  // The durable coding chats this panel shows: exactly the ones it has open for
  // this checkout, resolved to their live chatsStore records so the sidebar shows
  // the same titles (kept current by the sessionFile/title write-back) as every
  // other chat surface. Subscribing to allChats re-renders on any title change.
  const allChats = useChatsStore((s) => s.chatsByRoot[rootPath])
  const codingChats = useMemo(
    () => openChats
      .map((c) => (allChats ?? []).find((ch) => ch.id === c.chatId))
      .filter((c): c is Chat => !!c),
    [openChats, allChats],
  )
  // The active coding row is the one whose chatId maps to the active pi key —
  // but only when a coding chat is showing (a loop chat active means none is).
  const activeCodingChatId = activeLoopChatId ? null : activeChat?.chatId ?? null

  // Loop chats this checkout owns (chatsStore is the source of truth; the coding
  // mount effect already loads it). Rendered as their own sidebar section so the
  // panel can switch to an existing loop chat.
  const loopChats = useMemo(
    () => (allChats ?? []).filter((c) => chatMode(c) === 'loop'),
    [allChats],
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
  // for the active chat, so a background chat would keep sessionFile:null and a
  // later resume (after a restart) would have nothing to reopen. Poll any ready
  // chat missing a file (cheap get_state) and write it back onto the durable
  // coding chat. This spans all open chats, so it stays panel-owned. It also
  // covers the active chat, keeping its openChats/durable sessionFile in sync.
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
          const st = (await window.electronAPI.agentGetState(chat.agentKey)) as CodingRpcState | null
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
        <CateAgentPanelSidebar
          codingChats={codingChats}
          activeCodingChatId={activeCodingChatId}
          rootPath={rootPath}
          loopChats={loopChats}
          activeLoopChatId={activeLoopChatId}
          onNewCodingChat={handleNewCodingChat}
          onNewLoopChat={handleNewLoopChat}
          onOpenCodingChat={handleOpenCodingChat}
          onOpenLoopChat={handleOpenLoopChat}
          onDeleteCodingChat={handleDeleteCodingChat}
          onDeleteLoopChat={handleDeleteLoopChat}
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
        ) : activeLoopChatId ? (
          // Loop chat active: render its transcript + composer instead of the
          // coding body. The coding chats stay mounted-but-unrendered above; their
          // lifecycle effects still run (guarded on agentKey/sessionReady), so
          // nothing coding is torn down. LoopChatView brings its own composer, so
          // the coding composer/worktree pill deliberately does not render here.
          <div className="relative flex-1 flex flex-col min-h-0 overflow-y-auto">
            <Suspense fallback={null}>
              <LoopChatView wsId={workspaceId} rootPath={rootPath} chatId={activeLoopChatId} />
            </Suspense>
          </div>
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
              onCreateWorktree,
              onCheckoutPr,
            }}
          />
        )}
      </div>
    </div>
  )
}
