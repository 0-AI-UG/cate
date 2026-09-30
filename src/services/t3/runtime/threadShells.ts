// Live T3 thread shells. Each running harness gets one authenticated
// `orchestration.subscribeShell` stream (the protocol settingsRpc uses) whose
// snapshot and upsert/remove events fold into a full snapshot. This is the T3
// counterpart of the terminal agents' hook stream: activity is known without
// any T3 page being open.

import WebSocket from 'ws'
import { applyT3ShellEvent, type T3ShellSnapshot } from '../contract'

const REQUEST_ID = 'cate-shell'
const RECONNECT_MS = 2_000
const PUBLISH_MS = 100

interface ThreadShellSource {
  instanceId: string
  checkout: string
  url: string
  /** Cookie header for the harness's browser session. */
  cookie: string
  /** Whether the harness is still running, so a dropped stream may reconnect. */
  alive: () => boolean
}

/** One shell stream. Folds events into `state` and publishes coalesced full
 *  snapshots; reconnects while the harness is alive. */
export class ThreadShellSubscription {
  private socket: WebSocket | null = null
  private reconnect: ReturnType<typeof setTimeout> | undefined
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  state: T3ShellSnapshot

  constructor(private readonly source: ThreadShellSource, private readonly publish: (snapshot: T3ShellSnapshot) => void) {
    this.state = { instanceId: source.instanceId, checkout: source.checkout, connected: false, sequence: 0, threads: {} }
    this.connect()
  }

  private connect(): void {
    if (this.stopped) return
    const socket = new WebSocket(this.source.url.replace(/^http/, 'ws') + '/ws', {
      headers: { Cookie: this.source.cookie, Origin: this.source.url },
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
      for (const event of message.values ?? []) this.state = applyT3ShellEvent(this.state, event)
      this.schedulePublish()
      socket.send(JSON.stringify({ _tag: 'Ack', requestId: REQUEST_ID }))
    }
  }

  private setConnected(connected: boolean): void {
    if (this.state.connected === connected) return
    this.state = { ...this.state, connected }
    this.schedulePublish()
  }

  private schedulePublish(): void {
    if (this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      this.publish(this.state)
    }, PUBLISH_MS)
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.source.alive() || this.reconnect) return
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      this.connect()
    }, RECONNECT_MS)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.reconnect)
    clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.state = { ...this.state, connected: false }
    this.publish(this.state)
  }
}
