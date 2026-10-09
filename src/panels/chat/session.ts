// The chat panel session (architecture 11.2, 11.3). Owns the panel's thread
// binding and selection, asks the t3 service for its checkout's harness,
// follows the harness's thread shells for activity, restarts and deleted
// conversations, and keeps the agents service's t3 runner informed of its
// binding (the runner owns agent status, titles and attention notifications).
// The page itself lives in the view.

import path from 'node:path'
import { RpcError } from '@kernel/rpc/contract'
import { PanelSession, type OpHandlers, type SessionKit } from '@panels/framework/runtime'
import { AGENT_DEFS, agentIdForT3Provider, type AgentId } from '@services/agents/contract'
import {
  canT3ThreadReceivePrompt,
  t3ThreadActivity,
  type T3CheckoutParams,
  type T3PanelParams,
  type T3PanelTarget,
  type T3ShellEvent,
  type T3ShellSnapshot,
} from '@services/t3/contract'
import type { PanelCreateOptions } from '@panels/framework/contract'
import type { PanelId, PanelRecord, PanelType } from '@workspace/document/contract'
import {
  CHAT_DEFAULT_TITLE,
  CHAT_SURFACE_SEND_TEXT,
  chatThreadId,
  type ChatHarness,
  type ChatOp,
  type ChatSnapshot,
  type ChatTurnChange,
} from './contract'
import type { ChatBindings } from './parts/runtime/bindings'

/** The part of the t3 service a chat session uses. */
export interface ChatT3Service {
  panelUrl(params: T3PanelParams): Promise<T3PanelTarget>
  restart(params: T3CheckoutParams): Promise<void>
  renameConversation(params: T3CheckoutParams & { threadId: string; title: string }): Promise<void>
  watchThreadShells(listener: (event: T3ShellEvent) => void): () => void
}

/** A thread's recorded agent edits, from the agents service. */
export interface ChatChangesFeed {
  /** Records that the thread's changes were shown in this panel. */
  bind(checkout: string, threadId: string, panelId: string): Promise<void>
  /** Per-turn files the thread changed that are still changed in the
   *  checkout: now, then on every change. */
  watch(checkout: string, threadId: string, listener: (turns: Record<string, ChatTurnChange[]>) => void): () => void
}

export interface ChatSessionDeps {
  /** Canonical workspace root: the checkout of a panel without worktree or cwd. */
  root: string
  t3: ChatT3Service
  bindings?: ChatBindings
  relationContext?(panelId: PanelId, agentId: AgentId | null): Promise<string | null>
  changes?: ChatChangesFeed
  /** The runtime panel factory: builds records through each type's definition. */
  createPanel(type: PanelType, options: PanelCreateOptions & Record<string, unknown>): PanelId | null
}

const initial = (checkout: string, threadId: string | null): ChatSnapshot => ({
  checkout,
  threadId,
  phase: 'loading',
  error: null,
  harness: null,
  loadId: 0,
  connected: null,
  activity: null,
  agentName: null,
  canReceivePrompt: false,
  changes: null,
})

const message = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : typeof error === 'string' && error ? error : fallback

const harnessOf = (target: T3PanelTarget): ChatHarness => ({
  origin: new URL(target.url).origin,
  port: target.port,
  instanceId: target.instanceId,
  environmentId: target.environmentId,
  session: target.session,
})

const identityOf = (checkout: string, threadId: string | undefined) => JSON.stringify([checkout, threadId ?? null])

export class ChatSession extends PanelSession<ChatSnapshot, ChatOp> {
  /** The binding the page shows (checkout and thread). */
  private identity = ''
  private generation = 0
  private shell: T3ShellSnapshot | undefined
  private stopShells: (() => void) | undefined
  private stopChanges: (() => void) | undefined
  private changesKey = ''

  constructor(kit: SessionKit, record: PanelRecord, private readonly deps: ChatSessionDeps) {
    super(kit, record, initial(deps.root, chatThreadId(record) ?? null))
  }

  override start(): void {
    this.stopShells = this.deps.t3.watchThreadShells((event) => this.onShells(event))
    // Starting a harness can take a while; ops must not wait for it.
    void this.load()
  }

  /** The checkout this panel's conversation belongs to. */
  checkout(record: PanelRecord = this.record): string {
    if (typeof record.fields.cwd === 'string' && record.fields.cwd) return record.fields.cwd
    const worktree = record.worktreeId ? this.kit.document.get().worktrees[record.worktreeId] : undefined
    return worktree?.path ?? this.deps.root
  }

  protected override recordChanged(previous: PanelRecord): void {
    const threadId = chatThreadId(this.record)
    // A thread belongs to its checkout: switching worktree drops it (and an
    // explicit cwd); the resulting record change loads the fresh chat.
    if (previous.worktreeId !== this.record.worktreeId && (threadId || this.record.fields.cwd)
      && threadId === chatThreadId(previous)) {
      this.applyDoc({ kind: 'updatePanel', id: this.panelId, patch: { fields: { threadId: null, cwd: null } } })
      return
    }
    if (identityOf(this.checkout(), threadId) !== this.identity) void this.load()
  }

  protected override readonly ops: OpHandlers<ChatOp> = {
    retry: () => this.retry(),
    switchWorktree: ({ worktreeId }) => {
      if (worktreeId && !this.kit.document.get().worktrees[worktreeId]) throw new RpcError('gone', `no worktree ${String(worktreeId)}`)
      if ((worktreeId ?? undefined) === (this.record.worktreeId ?? undefined)) return
      // recordChanged drops the thread and loads the new checkout's chat.
      this.applyDoc({ kind: 'updatePanel', id: this.panelId, patch: { worktreeId } })
    },
    selectThread: ({ threadId, title, checkout }) => {
      if (checkout !== undefined && checkout !== this.checkout()) return false
      if ((threadId ?? undefined) === chatThreadId(this.record)) return true
      this.applyDoc({
        kind: 'updatePanel',
        id: this.panelId,
        patch: { title: threadId ? title || CHAT_DEFAULT_TITLE : CHAT_DEFAULT_TITLE, fields: { threadId } },
      })
      return true
    },
    adoptThread: ({ threadId }) => this.adopt(threadId ?? undefined),
    renameConversation: async ({ title }) => {
      const threadId = chatThreadId(this.record)
      if (!threadId) throw new RpcError('rejected', 'No conversation to rename.')
      await this.deps.t3.renameConversation({ checkout: this.checkout(), threadId, title })
    },
    loadFailed: ({ loadId, message: text }) => {
      if (loadId === this.state.loadId && this.state.phase === 'ready') this.publish({ phase: 'error', error: text || 'The agent page failed to load.' })
    },
    relationContext: async ({ provider }) =>
      (await this.deps.relationContext?.(this.panelId, provider ? agentIdForT3Provider(provider) : null)) ?? null,
    openFile: ({ path: relative, at, threadId }) => {
      this.requireBinding(threadId)
      if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.split(/[\\/]/).includes('..')) {
        throw new RpcError('rejected', 'File is outside this project.')
      }
      return this.create('editor', { at, filePath: path.join(this.checkout(), relative) }) !== null
    },
    openChanges: ({ at, filePath, turnId, threadId }) => {
      this.requireBinding(threadId)
      const sessionId = chatThreadId(this.record)
      const id = this.create('review', {
        at,
        title: 'Agent changes',
        repoPath: this.checkout(),
        request: {
          spec: { kind: 'uncommitted' },
          agentChanges: { panelId: this.panelId, ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) },
          ...(filePath ? { focusedFile: filePath } : {}),
        },
      })
      if (id && sessionId) void this.deps.changes?.bind(this.checkout(), sessionId, id).catch(() => undefined)
      return id !== null
    },
    openChat: ({ at, threadId, title }) => this.create('chat', {
      at,
      threadId,
      ...(typeof this.record.fields.cwd === 'string' ? { cwd: this.record.fields.cwd } : {}),
      ...(title ? { title } : {}),
    }) !== null,
  }

  /** Loads the current binding: asks for the harness and tells the view to
   *  load its page. */
  private async load(): Promise<void> {
    const checkout = this.checkout()
    const threadId = chatThreadId(this.record)
    const generation = ++this.generation
    this.identity = identityOf(checkout, threadId)
    this.publish({ checkout, threadId: threadId ?? null, phase: 'loading', error: null })
    this.bound()
    try {
      const target = await this.deps.t3.panelUrl({ checkout, ...(threadId ? { threadId } : {}), route: 'thread' })
      if (this.disposed || generation !== this.generation) return
      this.ready(target)
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      this.publish({ phase: 'error', error: message(error, 'The agent harness could not be started.') })
    }
  }

  private ready(target: T3PanelTarget): void {
    if (this.shell && this.shell.instanceId !== target.instanceId) this.shell = undefined
    this.publish({ phase: 'ready', error: null, harness: harnessOf(target), loadId: this.state.loadId + 1 })
    this.observe()
  }

  private async retry(): Promise<void> {
    const checkout = this.checkout()
    const generation = ++this.generation
    this.publish({ phase: 'loading', error: null })
    try {
      await this.deps.t3.restart({ checkout })
    } catch (error) {
      if (!this.disposed && generation === this.generation) {
        this.publish({ phase: 'error', error: message(error, 'The agent harness could not be restarted.') })
      }
      return
    }
    if (this.disposed || generation !== this.generation) return
    await this.load()
  }

  /** A harness that came back (restarted, maybe on another port): the view
   *  reloads when its address changed. */
  private async reconnect(): Promise<void> {
    const generation = this.generation
    const checkout = this.checkout()
    const threadId = chatThreadId(this.record)
    try {
      const target = await this.deps.t3.panelUrl({ checkout, ...(threadId ? { threadId } : {}), route: 'thread' })
      if (this.disposed || generation !== this.generation) return
      const current = this.state.harness
      if (this.state.phase !== 'ready' || !current || current.port !== target.port || current.session.value !== target.session.value) {
        this.ready(target)
      }
    } catch {
      // The next snapshot or a retry tries again.
    }
  }

  private adopt(threadId: string | undefined): void {
    if (threadId === chatThreadId(this.record)) return
    this.identity = identityOf(this.checkout(), threadId)
    this.applyDoc({ kind: 'updatePanel', id: this.panelId, patch: { fields: { threadId: threadId ?? null } } })
    this.publish({ threadId: threadId ?? null })
    this.bound()
    this.observe()
  }

  private onShells(event: T3ShellEvent): void {
    if (this.disposed) return
    const instanceId = this.state.harness?.instanceId
    if (event.kind === 'deleted') {
      // A conversation deleted anywhere closes the panels showing it.
      if (event.instanceId === instanceId && event.threadId === chatThreadId(this.record)) {
        this.applyDoc({ kind: 'removePanels', ids: [this.panelId] })
      }
      return
    }
    const { snapshot } = event
    if (!instanceId || snapshot.instanceId !== instanceId) return
    const wasConnected = this.shell?.connected
    this.shell = snapshot
    this.observe()
    if (snapshot.connected && (wasConnected === false || this.state.phase === 'error')) void this.reconnect()
  }

  /** Activity of the bound thread from the harness's thread shells. */
  private observe(): void {
    const shell = this.shell
    const threadId = chatThreadId(this.record)
    const thread = threadId && shell?.connected ? shell.threads[threadId] : undefined
    const provider = thread?.session?.providerName
    const agentId = provider ? agentIdForT3Provider(provider) : null
    this.publish({
      connected: shell ? shell.connected : null,
      activity: thread ? t3ThreadActivity(thread) : null,
      agentName: agentId ? AGENT_DEFS[agentId].displayName : CHAT_DEFAULT_TITLE,
      // A fresh chat's first prompt creates its thread; a bound thread must be known.
      canReceivePrompt: shell?.connected === true && (threadId ? !!thread && canT3ThreadReceivePrompt(thread) : true),
    })
  }

  /** Tells the runner and the change feed about the current binding. */
  private bound(): void {
    const checkout = this.checkout()
    const threadId = chatThreadId(this.record)
    this.deps.bindings?.set(this.panelId, { checkout, ...(threadId ? { threadId } : {}) }, (prompt) => this.sendFresh(prompt))
    const key = identityOf(checkout, threadId)
    if (key === this.changesKey) return
    this.changesKey = key
    this.stopChanges?.()
    this.stopChanges = undefined
    this.publish({ changes: null })
    if (!threadId || !this.deps.changes) return
    void this.deps.changes.bind(checkout, threadId, this.panelId).catch(() => undefined)
    this.stopChanges = this.deps.changes.watch(checkout, threadId, (turns) => {
      if (chatThreadId(this.record) === threadId) this.publish({ changes: { threadId, turns } })
    })
  }

  /** A fresh chat's first prompt, through the page composer on the driving
   *  client (it holds the provider and model choice). */
  private async sendFresh(prompt: string): Promise<boolean> {
    try {
      return (await this.withSurface<boolean>(CHAT_SURFACE_SEND_TEXT, { text: prompt })) === true
    } catch {
      return false
    }
  }

  private requireBinding(threadId: string | undefined): void {
    if (threadId && threadId !== chatThreadId(this.record)) throw new RpcError('rejected', 'Conversation changed. Please try again.')
  }

  private create(type: PanelType, options: Record<string, unknown>): PanelId | null {
    return this.deps.createPanel(type, {
      near: this.panelId,
      ...(this.record.worktreeId ? { worktreeId: this.record.worktreeId } : {}),
      ...options,
    })
  }

  private applyDoc(change: Parameters<SessionKit['document']['apply']>[0]): void {
    try {
      this.kit.document.apply(change)
    } catch (error) {
      this.kit.log.warn('chat %s: document change refused: %s', this.panelId, message(error, 'refused'))
    }
  }

  protected override release(): void {
    this.generation++
    this.stopShells?.()
    this.stopChanges?.()
    this.deps.bindings?.delete(this.panelId)
  }
}
