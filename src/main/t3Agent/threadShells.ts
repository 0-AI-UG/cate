import WebSocket from 'ws'
import type { T3ShellSnapshot, T3Thread } from '../../shared/t3Agent'

// =============================================================================
// Live T3 thread shells, subscribed from main. Each running harness gets one
// authenticated `orchestration.subscribeShell` stream (T3's pinned Effect JSON
// RPC, the same protocol settingsRpc uses) whose snapshot + upsert/remove
// events are folded into a full per-partition snapshot. This is the T3
// counterpart of the terminal agents' hook stream: activity reaches every
// window without any T3 page being mounted.
// =============================================================================

const REQUEST_ID = 'cate-shell'
const RECONNECT_MS = 2_000
const PUBLISH_MS = 100

function pick(thread: Record<string, unknown>): T3Thread {
  return {
    id: String(thread.id),
    title: String(thread.title ?? ''),
    latestTurn: thread.latestTurn as T3Thread['latestTurn'],
    session: thread.session as T3Thread['session'],
    hasPendingApprovals: thread.hasPendingApprovals as boolean | undefined,
    hasPendingUserInput: thread.hasPendingUserInput as boolean | undefined,
    hasActionableProposedPlan: thread.hasActionableProposedPlan as boolean | undefined,
    backgroundLiveness: thread.backgroundLiveness as T3Thread['backgroundLiveness'],
  }
}

export interface ThreadShellSource {
  partition: string
  url: string
  /** Cookie header for the harness's browser session. */
  cookie: () => Promise<string>
  /** Whether the harness is still running, so a dropped stream may reconnect. */
  alive: () => boolean
}

/** One shell stream. Folds events into `state` and publishes coalesced
 *  full snapshots; reconnects while the harness is alive. */
export class ThreadShellSubscription {
  private socket: WebSocket | null = null
  private reconnect: ReturnType<typeof setTimeout> | undefined
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  readonly state: T3ShellSnapshot

  constructor(private readonly source: ThreadShellSource, private readonly publish: (snapshot: T3ShellSnapshot) => void) {
    this.state = { partition: source.partition, connected: false, sequence: 0, threads: {} }
    void this.connect()
  }

  private async connect(): Promise<void> {
    if (this.stopped) return
    let cookie: string
    try { cookie = await this.source.cookie() } catch { this.scheduleReconnect(); return }
    if (this.stopped) return
    const socket = new WebSocket(this.source.url.replace(/^http/, 'ws') + '/ws', {
      headers: { Cookie: cookie, Origin: this.source.url },
    })
    this.socket = socket
    socket.on('open', () => socket.send(JSON.stringify({
      _tag: 'Request', id: REQUEST_ID, tag: 'orchestration.subscribeShell', payload: {}, headers: [],
    })))
    socket.on('message', (data) => this.receive(socket, data.toString()))
    socket.on('error', () => socket.close())
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.setConnected(false)
      this.scheduleReconnect()
    })
  }

  private receive(socket: WebSocket, data: string): void {
    let decoded: unknown
    try { decoded = JSON.parse(data) } catch { socket.close(); return }
    for (const message of (Array.isArray(decoded) ? decoded : [decoded]) as Array<Record<string, any>>) {
      if (message._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); continue }
      if (message.requestId !== REQUEST_ID) continue
      if (message._tag === 'Exit') { socket.close(); continue }
      if (message._tag !== 'Chunk') continue
      for (const event of message.values ?? []) this.apply(event)
      socket.send(JSON.stringify({ _tag: 'Ack', requestId: REQUEST_ID }))
    }
  }

  private apply(event: Record<string, any>): void {
    const state = this.state
    if (event.kind === 'snapshot') {
      state.threads = Object.fromEntries((event.snapshot?.threads ?? []).map((thread: Record<string, unknown>) => [String(thread.id), pick(thread)]))
      state.sequence = event.snapshot?.snapshotSequence ?? state.sequence
      state.connected = true
    } else if (event.kind === 'thread-upserted' && event.thread) {
      state.threads = { ...state.threads, [String(event.thread.id)]: pick(event.thread) }
    } else if (event.kind === 'thread-removed') {
      const { [String(event.threadId)]: _removed, ...rest } = state.threads
      state.threads = rest
    }
    if (typeof event.sequence === 'number') state.sequence = event.sequence
    this.schedulePublish()
  }

  private setConnected(connected: boolean): void {
    if (this.state.connected === connected) return
    this.state.connected = connected
    this.schedulePublish()
  }

  private schedulePublish(): void {
    if (this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      this.publish({ ...this.state })
    }, PUBLISH_MS)
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.source.alive() || this.reconnect) return
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      void this.connect()
    }, RECONNECT_MS)
  }

  /** Resume after the harness came back (the stream stopped reconnecting
   *  while it was down). */
  resume(): void {
    if (this.stopped || this.socket || this.reconnect) return
    void this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.reconnect)
    clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.state.connected = false
    this.publish({ ...this.state })
  }
}
