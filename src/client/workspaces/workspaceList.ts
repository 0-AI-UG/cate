// The device's workspace list (12.1, 16): local recents by root path, paired
// workspaces by runtimeId, and the sidebar order, in the `workspaces` device
// document. Pinned runtime keys live in `known-runtimes` (runtime/pairing).
// Opening a workspace is opening its connection.

import type { DeviceStore } from '@kernel/state/contract'
import type { WorkspaceConnection, WorkspaceConnections, ConnectionTarget } from '@client/connections'
import type { NetworkEndpoint } from '@runtime/transports/contract'
import { KnownRuntimes } from '@runtime/pairing/client'

export const WORKSPACES_DOCUMENT = 'workspaces'
const RECENTS_LIMIT = 30

export interface LocalWorkspace {
  kind: 'local'
  id: string
  root: string
  name: string
  lastOpenedAt: number
}

export interface PairedWorkspace {
  kind: 'paired'
  id: string
  runtimeId: string
  name: string
  endpoints: NetworkEndpoint[]
  pairedAt: number
  lastOpenedAt: number | null
}

export type WorkspaceEntry = LocalWorkspace | PairedWorkspace

interface WorkspacesFile {
  local: Omit<LocalWorkspace, 'kind' | 'id'>[]
  paired: Omit<PairedWorkspace, 'kind' | 'id'>[]
  /** Sidebar order by workspace id; entries not named follow, newest first. */
  order: string[]
}

export interface WorkspaceListSnapshot {
  /** In sidebar order. */
  entries: readonly WorkspaceEntry[]
  /** Ids of the workspaces open in this client. */
  open: readonly string[]
}

export const localWorkspaceId = (root: string) => `local:${root}`
/** The root of a local workspace id, or null for another kind. */
export const localRootOf = (id: string): string | null => id.startsWith('local:') ? id.slice('local:'.length) : null
export const pairedWorkspaceId = (runtimeId: string) => `paired:${runtimeId}`

export function targetOf(entry: WorkspaceEntry): ConnectionTarget {
  return entry.kind === 'local'
    ? { kind: 'local', root: entry.root }
    : { kind: 'network', runtimeId: entry.runtimeId, endpoints: entry.endpoints }
}

export interface WorkspaceListOptions {
  store: DeviceStore
  connections: WorkspaceConnections
  now?: () => number
}

export class WorkspaceList {
  readonly known: KnownRuntimes
  private readonly store: DeviceStore
  private readonly connections: WorkspaceConnections
  private readonly now: () => number
  private file: WorkspacesFile = { local: [], paired: [], order: [] }
  private snapshot: WorkspaceListSnapshot = { entries: [], open: [] }
  private readonly listeners = new Set<() => void>()
  private readonly stops: (() => void)[] = []

  constructor(opts: WorkspaceListOptions) {
    this.store = opts.store
    this.connections = opts.connections
    this.now = opts.now ?? Date.now
    this.known = new KnownRuntimes(opts.store, this.now)
    this.stops.push(opts.connections.subscribe(() => this.refresh()))
  }

  /** Reads the file and follows outside edits to it. */
  async load(): Promise<void> {
    this.file = normalize(await this.store.get(WORKSPACES_DOCUMENT))
    this.stops.push(this.store.subscribe(WORKSPACES_DOCUMENT, (value) => {
      this.file = normalize(value)
      this.refresh()
    }))
    this.refresh()
  }

  getSnapshot = (): WorkspaceListSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get(id: string): WorkspaceEntry | undefined {
    return this.snapshot.entries.find((e) => e.id === id)
  }

  /** Records a local workspace (or refreshes it) as just opened. */
  async addLocal(root: string, name = basename(root)): Promise<LocalWorkspace> {
    const lastOpenedAt = this.now()
    const rest = this.file.local.filter((w) => w.root !== root)
    this.file = { ...this.file, local: [{ root, name, lastOpenedAt }, ...rest].slice(0, RECENTS_LIMIT) }
    await this.save()
    return this.get(localWorkspaceId(root)) as LocalWorkspace
  }

  /** Records a workspace this device just paired with and pins its key. */
  async addPaired(opts: { runtimeId: string; name: string; endpoints: NetworkEndpoint[]; publicKey: Uint8Array }): Promise<PairedWorkspace> {
    await this.known.pin(opts.runtimeId, opts.publicKey)
    const rest = this.file.paired.filter((w) => w.runtimeId !== opts.runtimeId)
    const entry = { runtimeId: opts.runtimeId, name: opts.name, endpoints: opts.endpoints, pairedAt: this.now(), lastOpenedAt: null }
    this.file = { ...this.file, paired: [...rest, entry] }
    await this.save()
    return this.get(pairedWorkspaceId(opts.runtimeId)) as PairedWorkspace
  }

  async rename(id: string, name: string): Promise<void> {
    this.file = {
      ...this.file,
      local: this.file.local.map((w) => (localWorkspaceId(w.root) === id ? { ...w, name } : w)),
      paired: this.file.paired.map((w) => (pairedWorkspaceId(w.runtimeId) === id ? { ...w, name } : w)),
    }
    await this.save()
  }

  /** Opens the workspace's connection and marks it opened. */
  async open(id: string): Promise<WorkspaceConnection> {
    const entry = this.get(id)
    if (!entry) throw new Error(`Unknown workspace ${id}`)
    const connection = this.connections.open(id, targetOf(entry))
    const lastOpenedAt = this.now()
    this.file = {
      ...this.file,
      local: this.file.local.map((w) => (localWorkspaceId(w.root) === id ? { ...w, lastOpenedAt } : w)),
      paired: this.file.paired.map((w) => (pairedWorkspaceId(w.runtimeId) === id ? { ...w, lastOpenedAt } : w)),
    }
    await this.save()
    return connection
  }

  close(id: string): void {
    this.connections.close(id)
  }

  /** Drops a local workspace from the recents. */
  async removeRecent(id: string): Promise<void> {
    this.close(id)
    this.file = { ...this.file, local: this.file.local.filter((w) => localWorkspaceId(w.root) !== id) }
    await this.save()
  }

  /** "Forget this workspace": closes it, deletes the pinned key and the entry. */
  async forget(id: string): Promise<void> {
    const entry = this.get(id)
    if (!entry || entry.kind !== 'paired') return
    this.close(id)
    await this.known.forget(entry.runtimeId)
    this.file = { ...this.file, paired: this.file.paired.filter((w) => w.runtimeId !== entry.runtimeId) }
    await this.save()
  }

  /** Sets the sidebar order. */
  async reorder(ids: readonly string[]): Promise<void> {
    this.file = { ...this.file, order: [...new Set(ids)] }
    await this.save()
  }

  dispose(): void {
    for (const stop of this.stops.splice(0)) stop()
    this.listeners.clear()
  }

  private async save(): Promise<void> {
    const known = new Set(entriesOf(this.file).map((e) => e.id))
    this.file = { ...this.file, order: this.file.order.filter((id) => known.has(id)) }
    this.refresh()
    await this.store.set(WORKSPACES_DOCUMENT, this.file)
  }

  private refresh(): void {
    const entries = sortEntries(entriesOf(this.file), this.file.order)
    const open = this.connections.getSnapshot().map((c) => c.workspaceId)
    this.snapshot = { entries, open }
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }
}

function entriesOf(file: WorkspacesFile): WorkspaceEntry[] {
  return [
    ...file.local.map((w): LocalWorkspace => ({ kind: 'local', id: localWorkspaceId(w.root), ...w })),
    ...file.paired.map((w): PairedWorkspace => ({ kind: 'paired', id: pairedWorkspaceId(w.runtimeId), ...w })),
  ]
}

function sortEntries(entries: WorkspaceEntry[], order: readonly string[]): WorkspaceEntry[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const recency = (e: WorkspaceEntry) => (e.kind === 'local' ? e.lastOpenedAt : e.lastOpenedAt ?? e.pairedAt)
  return [...entries].sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return recency(b) - recency(a)
  })
}

function basename(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function normalizeEndpoint(value: unknown): NetworkEndpoint | null {
  const e = value as Partial<{ kind: string; address: unknown; port: unknown }> | null
  if (!e || typeof e !== 'object') return null
  if (e.kind === 'connect') return { kind: 'connect' }
  if (e.kind === 'lan' && isStr(e.address) && isNum(e.port)) return { kind: 'lan', address: e.address, port: e.port }
  return null
}

/** Keeps the well-formed parts of a hand-edited or missing file. */
function normalize(value: unknown): WorkspacesFile {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof WorkspacesFile, unknown>>
  const list = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []
  const local: WorkspacesFile['local'] = []
  for (const w of list(raw.local)) {
    if (!isStr(w.root) || local.some((l) => l.root === w.root)) continue
    local.push({ root: w.root, name: isStr(w.name) ? w.name : basename(w.root), lastOpenedAt: isNum(w.lastOpenedAt) ? w.lastOpenedAt : 0 })
  }
  const paired: WorkspacesFile['paired'] = []
  for (const w of list(raw.paired)) {
    if (!isStr(w.runtimeId) || paired.some((p) => p.runtimeId === w.runtimeId)) continue
    paired.push({
      runtimeId: w.runtimeId,
      name: isStr(w.name) ? w.name : w.runtimeId,
      endpoints: Array.isArray(w.endpoints) ? w.endpoints.map(normalizeEndpoint).filter((e): e is NetworkEndpoint => e !== null) : [],
      pairedAt: isNum(w.pairedAt) ? w.pairedAt : 0,
      lastOpenedAt: isNum(w.lastOpenedAt) ? w.lastOpenedAt : null,
    })
  }
  const order = Array.isArray(raw.order) ? [...new Set(raw.order.filter(isStr))] : []
  return { local, paired, order }
}
