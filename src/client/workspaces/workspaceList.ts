// The device's workspace list (12.1, 16): local recents by root path,
// workspaces on machines this device runs commands on (SSH, WSL) by machine
// and root, paired workspaces by runtimeId, and the sidebar order, in the
// `workspaces` device document. Pinned runtime keys live in `known-runtimes` (runtime/pairing).
// Opening a workspace is opening its connection.

import type { DeviceStore } from '@kernel/state/contract'
import type { WorkspaceConnection, WorkspaceConnections, ConnectionTarget } from '@client/connections'
import type { NetworkEndpoint } from '@runtime/transports/contract'
import { isMachine, machineKey, machineLabel, type Machine } from '@runtime/daemon/contract'
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

export interface MachineWorkspace {
  kind: 'machine'
  id: string
  machine: Machine
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

export type WorkspaceEntry = LocalWorkspace | MachineWorkspace | PairedWorkspace

interface WorkspacesFile {
  local: Omit<LocalWorkspace, 'kind' | 'id'>[]
  machine: Omit<MachineWorkspace, 'kind' | 'id'>[]
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
export const machineWorkspaceId = (machine: Machine, root: string) => `machine:${machineKey(machine)}:${root}`
export const pairedWorkspaceId = (runtimeId: string) => `paired:${runtimeId}`

export function targetOf(entry: WorkspaceEntry): ConnectionTarget {
  if (entry.kind === 'local') return { kind: 'local', root: entry.root }
  if (entry.kind === 'machine') return { kind: 'machine', machine: entry.machine, root: entry.root }
  return { kind: 'network', runtimeId: entry.runtimeId, endpoints: entry.endpoints }
}

/** Where the workspace lives, to show next to its name: its folder, with
 *  the machine when it is on another one; null for a paired workspace. */
export function workspaceLocation(entry: WorkspaceEntry): string | null {
  if (entry.kind === 'local') return entry.root
  if (entry.kind === 'machine') return `${machineLabel(entry.machine)}:${entry.root}`
  return null
}

const idOf = {
  local: (w: { root: string }) => localWorkspaceId(w.root),
  machine: (w: { machine: Machine; root: string }) => machineWorkspaceId(w.machine, w.root),
  paired: (w: { runtimeId: string }) => pairedWorkspaceId(w.runtimeId),
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
  private file: WorkspacesFile = { local: [], machine: [], paired: [], order: [] }
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

  /** Records a workspace on a machine this device runs commands on (or
   *  refreshes it) as just opened. */
  async addMachine(machine: Machine, root: string, name = basename(root)): Promise<MachineWorkspace> {
    const id = machineWorkspaceId(machine, root)
    const lastOpenedAt = this.now()
    const rest = this.file.machine.filter((w) => idOf.machine(w) !== id)
    this.file = { ...this.file, machine: [{ machine, root, name, lastOpenedAt }, ...rest].slice(0, RECENTS_LIMIT) }
    await this.save()
    return this.get(id) as MachineWorkspace
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
      local: this.file.local.map((w) => (idOf.local(w) === id ? { ...w, name } : w)),
      machine: this.file.machine.map((w) => (idOf.machine(w) === id ? { ...w, name } : w)),
      paired: this.file.paired.map((w) => (idOf.paired(w) === id ? { ...w, name } : w)),
    }
    await this.save()
  }

  /** Opens the workspace's connection and marks it opened. */
  async open(id: string): Promise<WorkspaceConnection> {
    const entry = this.get(id)
    if (!entry) throw new Error(`Unknown workspace ${id}`)
    const fresh = !this.connections.get(id)
    const connection = this.connections.open(id, targetOf(entry))
    if (fresh && entry.kind === 'paired') this.followEndpoints(connection, entry.runtimeId)
    const lastOpenedAt = this.now()
    this.file = {
      ...this.file,
      local: this.file.local.map((w) => (idOf.local(w) === id ? { ...w, lastOpenedAt } : w)),
      machine: this.file.machine.map((w) => (idOf.machine(w) === id ? { ...w, lastOpenedAt } : w)),
      paired: this.file.paired.map((w) => (idOf.paired(w) === id ? { ...w, lastOpenedAt } : w)),
    }
    await this.save()
    return connection
  }

  /** Keeps a paired workspace's addresses current: on every connect the
   *  runtime says where it is reachable now, for the next dial and the next
   *  launch. */
  private followEndpoints(connection: WorkspaceConnection, runtimeId: string): void {
    let asked = false
    connection.subscribe(() => {
      if (connection.state.kind !== 'connected') { asked = false; return }
      if (asked) return
      asked = true
      connection.runtime.runtime.info().then(async (info) => {
        const endpoints = info.endpoints
        const current = this.file.paired.find((w) => w.runtimeId === runtimeId)
        if (!endpoints?.length || !current || JSON.stringify(endpoints) === JSON.stringify(current.endpoints)) return
        connection.retarget({ kind: 'network', runtimeId, endpoints })
        this.file = { ...this.file, paired: this.file.paired.map((w) => (w.runtimeId === runtimeId ? { ...w, endpoints } : w)) }
        await this.save()
      }).catch(() => { /* asked again on the next connect */ })
    })
  }

  close(id: string): void {
    this.connections.close(id)
  }

  /** Drops a local workspace, or one on a machine, from the recents. */
  async removeRecent(id: string): Promise<void> {
    this.close(id)
    this.file = {
      ...this.file,
      local: this.file.local.filter((w) => idOf.local(w) !== id),
      machine: this.file.machine.filter((w) => idOf.machine(w) !== id),
    }
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
    ...file.machine.map((w): MachineWorkspace => ({ kind: 'machine', id: idOf.machine(w), ...w })),
    ...file.paired.map((w): PairedWorkspace => ({ kind: 'paired', id: pairedWorkspaceId(w.runtimeId), ...w })),
  ]
}

function sortEntries(entries: WorkspaceEntry[], order: readonly string[]): WorkspaceEntry[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  const recency = (e: WorkspaceEntry) => (e.kind === 'paired' ? e.lastOpenedAt ?? e.pairedAt : e.lastOpenedAt)
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
  const machine: WorkspacesFile['machine'] = []
  for (const w of list(raw.machine)) {
    if (!isStr(w.root) || !isMachine(w.machine)) continue
    const id = machineWorkspaceId(w.machine, w.root)
    if (machine.some((m) => idOf.machine(m) === id)) continue
    machine.push({ machine: w.machine, root: w.root, name: isStr(w.name) ? w.name : basename(w.root), lastOpenedAt: isNum(w.lastOpenedAt) ? w.lastOpenedAt : 0 })
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
  return { local, machine, paired, order }
}
