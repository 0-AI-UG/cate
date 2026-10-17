// A guest's console messages, uncaught errors and requests, recorded from
// the page driver's CDP events for `console` and `network`.

import type { BrowserConsoleEntry, BrowserNetworkEntry } from '../contract'

/** Entries kept per guest (the newest), and the longest text of one. */
const LOG_LIMIT = 500
const LOG_TEXT_LIMIT = 2_000

interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** A console argument as text. */
function remoteText(raw: unknown): string {
  const value = objectValue(raw)
  if (value.value !== undefined) return typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
  return String(value.unserializableValue ?? value.description ?? value.type ?? '')
}

const consoleLevel = (type: unknown): BrowserConsoleEntry['level'] =>
  type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warning' : type === 'info' ? 'info' : type === 'debug' ? 'debug' : 'log'

export class PageLog {
  private console: BrowserConsoleEntry[] = []
  /** Requests by id, oldest first. */
  private network = new Map<string, BrowserNetworkEntry & { started: number }>()

  /** Records what `event` says about the console or the network. */
  record(event: CdpEvent): void {
    if (event.method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(event.params.args) ? event.params.args : []
      const callFrames = objectValue(event.params.stackTrace).callFrames
      const frame = objectValue(Array.isArray(callFrames) ? callFrames[0] : undefined)
      this.recordConsole({
        at: Date.now(), level: consoleLevel(event.params.type), text: args.map(remoteText).join(' '),
        ...(frame.url ? { source: `${String(frame.url)}:${Number(frame.lineNumber ?? 0) + 1}` } : {}),
      })
    } else if (event.method === 'Runtime.exceptionThrown') {
      const details = objectValue(event.params.exceptionDetails)
      const description = objectValue(details.exception).description
      this.recordConsole({
        at: Date.now(), level: 'error', text: String(description ?? details.text ?? 'Uncaught exception').split('\n')[0],
        ...(details.url ? { source: `${String(details.url)}:${Number(details.lineNumber ?? 0) + 1}` } : {}),
      })
    } else if (event.method.startsWith('Network.')) this.recordRequest(event)
  }

  private recordConsole(entry: BrowserConsoleEntry): void {
    this.console.push({ ...entry, text: entry.text.slice(0, LOG_TEXT_LIMIT) })
    if (this.console.length > LOG_LIMIT) this.console.splice(0, this.console.length - LOG_LIMIT)
  }

  private recordRequest(event: CdpEvent): void {
    const id = typeof event.params.requestId === 'string' ? `${event.sessionId ?? 'root'}:${event.params.requestId}` : undefined
    if (!id) return
    if (event.method === 'Network.requestWillBeSent') {
      const request = objectValue(event.params.request)
      const url = String(request.url ?? '')
      if (!url || url.startsWith('data:')) return
      this.network.delete(id)
      this.network.set(id, { at: Date.now(), started: performance.now(), method: String(request.method ?? 'GET'), url: url.slice(0, LOG_TEXT_LIMIT), type: String(event.params.type ?? 'Other') })
      if (this.network.size > LOG_LIMIT) this.network.delete(this.network.keys().next().value!)
      return
    }
    const entry = this.network.get(id)
    if (!entry) return
    if (event.method === 'Network.responseReceived') entry.status = Number(objectValue(event.params.response).status)
    else if (event.method === 'Network.loadingFailed') {
      entry.error = event.params.canceled === true ? 'canceled' : String(event.params.errorText ?? 'failed')
      entry.durationMs = performance.now() - entry.started
    } else if (event.method === 'Network.loadingFinished') entry.durationMs = performance.now() - entry.started
  }

  /** The console messages (`method` console) or requests (network) recorded so far. */
  read(method: string, args: Record<string, unknown>): { entries: Array<BrowserConsoleEntry | BrowserNetworkEntry>; total: number } {
    const limit = args.limit === undefined ? 100 : Number(args.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > LOG_LIMIT) throw new Error('invalid-browser-log-limit')
    let entries: Array<BrowserConsoleEntry | BrowserNetworkEntry>
    if (method === 'console') {
      const level = args.level ?? 'all'
      if (!['all', 'error', 'warning'].includes(String(level))) throw new Error('invalid-browser-console-level')
      entries = this.console.filter(entry => level === 'all' || entry.level === 'error' || (level === 'warning' && entry.level === 'warning'))
      if (args.clear === true) this.console = []
    } else {
      const filter = typeof args.filter === 'string' ? args.filter : ''
      entries = [...this.network.values()]
        .filter(entry => (!filter || entry.url.includes(filter)) && (args.failed !== true || entry.error !== undefined || (entry.status ?? 0) >= 400))
        .map(({ started: _started, ...entry }) => entry)
      if (args.clear === true) this.network.clear()
    }
    return { entries: entries.slice(-limit), total: entries.length }
  }

  clear(): void {
    this.console = []
    this.network.clear()
  }
}
