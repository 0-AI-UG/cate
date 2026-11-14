import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { PatchHistory } from '@workspace/repository/runtime'
import { parseReviewPatch } from '@workspace/repository/contract'
import { writeJsonAtomic, writeJsonExclusive } from '@kernel/state/node'
import {
  AGENT_HOOK_SPECS,
  type AgentChangeRecord,
  type AgentHookEvent,
  type AgentId,
  type AgentToolCall,
} from '../../contract'
import { filesFromTool } from './edits'

/** Where a hook post with edits comes from: a terminal's PTY, bound to the
 *  checkout it runs in. */
export interface AgentChangeTerminal { cwd: string; panelId?: string }

/** A record as stored: the terminal PTY it came from and that terminal's
 *  panel. The agents service resolves it to the contract's record. */
export type StoredAgentChange = Omit<AgentChangeRecord, 'panelIds' | 'files'> & {
  files: Array<AgentChangeRecord['files'][number] & { baseCommit?: string }>
  terminalId: string
  panelId?: string
}

export interface StoredChangesSnapshot {
  revision: string
  records?: StoredAgentChange[]
}

export type AgentChangesStore = ReturnType<typeof createAgentChangesStore>

/**
 * Change history per checkout in `<data>/agents/changes/<sha256(cwd)>.d/`.
 * Only reported patches are saved, never raw prompts, tool output or
 * working-tree snapshots. Each hook publishes a unique file. Only this store updates its commit
 * attribution or removes verified reverts; patches are never duplicated as hunks.
 */
export function createAgentChangesStore(directory: string, panelTitle?: (panelId: string) => string | undefined, history?: PatchHistory, pullRequestNumber?: (cwd: string) => number | undefined) {
  const canonical = (cwd: string) => { try { return realpathSync.native(cwd) } catch { return path.resolve(cwd) } }
  const listeners = new Set<(cwd: string) => void>()
  const notify = (cwd: string) => {
    for (const listener of listeners) { try { listener(cwd) } catch { /* Subscribers cannot interrupt capture or reads. */ } }
  }
  const terminals = new Map<string, AgentChangeTerminal>()
  const turns = new Map<string, string>()
  const queues = new Map<string, Set<Promise<void>>>()
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const folderFor = (cwd: string) => path.join(directory, hash(canonical(cwd)) + '.d')
  type DiskRecord = Omit<StoredAgentChange, 'files'> & { files: Array<Omit<StoredAgentChange['files'][number], 'hunks'> & { hunks?: StoredAgentChange['files'][number]['hunks'] }> }
  type Entry = { record?: DiskRecord; decoded?: StoredAgentChange }
  const encode = (record: StoredAgentChange): Entry => ({ record: { ...record, files: record.files.map((file) => {
    const { hunks, ...rest } = file
    return file.patch && JSON.stringify(parseReviewPatch(file.patch)) === JSON.stringify(hunks) ? rest : file
  }) } })
  const decode = (record: DiskRecord): StoredAgentChange => ({ ...record, files: record.files.map((file) => ({ ...file, hunks: file.hunks ?? parseReviewPatch(file.patch ?? '') })) })
  const listings = new Map<string, { stamp: string; names: string[] }>()
  const loaded = new Map<string, { revision: string; records: StoredAgentChange[] }>()
  const snapshots = new Map<string, StoredChangesSnapshot>()
  const versions = new Map<string, number>()
  const reading = new Map<string, { version: number; task: Promise<StoredChangesSnapshot> }>()
  const entries = new Map<string, Entry>()

  const snapshotOf = (records: StoredAgentChange[]): StoredChangesSnapshot => ({
    revision: hash(JSON.stringify(records.map((record) => [record.id, record.files.map((file) => [file.path, file.commit?.hash, file.uncommitted])]))),
    records,
  })

  const save = async (record: StoredAgentChange): Promise<void> => {
    const cwd = record.cwd
    const pending = writeJsonExclusive(path.join(folderFor(cwd), `${record.id}.json`), encode(record))
    const active = queues.get(cwd) ?? new Set<Promise<void>>()
    active.add(pending)
    queues.set(cwd, active)
    try {
      await pending
      listings.delete(cwd)
      loaded.delete(cwd)
      versions.set(cwd, (versions.get(cwd) ?? 0) + 1)
    } finally {
      active.delete(pending)
      if (!active.size) queues.delete(cwd)
    }
  }
  const readChanges = async (cwd: string): Promise<StoredChangesSnapshot> => {
    cwd = canonical(cwd)
    await Promise.all(queues.get(cwd) ?? [])
    const folder = folderFor(cwd)
    const stamp = await stat(folder).then((s) => `${s.mtimeMs}:${s.ctimeMs}`, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''; throw error
    })
    const previous = listings.get(cwd)
    const names = previous?.stamp === stamp ? previous.names : (await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]; throw error
    })).filter((name) => name.endsWith('.json')).sort()
    listings.set(cwd, { stamp, names })
    const directoryRevision = hash(JSON.stringify(names))
    const cached = loaded.get(cwd)
    const records = new Map<string, StoredAgentChange>()
    if (cached?.revision === directoryRevision) for (const record of cached.records) records.set(record.id, record)
    else for (const name of names) {
      const file = path.join(folder, name)
      let entry = entries.get(file)
      if (!entry) {
        const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (raw === null) continue
        entry = JSON.parse(raw) as Entry
        entries.set(file, entry)
      }
      if (entry.record && !records.has(entry.record.id)) records.set(entry.record.id, entry.decoded ??= decode(entry.record))
    }
    const all = [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    loaded.set(cwd, { revision: directoryRevision, records: all })
    // Recorded edits are already useful before Git attribution finishes. On a
    // cold read, publish them once and verify their live classification next.
    if (!snapshots.has(cwd)) {
      snapshots.set(cwd, snapshotOf(all))
      notify(cwd)
    }
    const evidence = await history?.reconcile(cwd, all.flatMap((record) => record.files.map((file) => ({ ...file, key: `${record.id}:${file.path}`, createdAt: record.createdAt }))))
    const retained: StoredAgentChange[] = []
    for (const record of all) {
      const files = record.files.filter((file) => !evidence?.get(`${record.id}:${file.path}`)?.reverted).map((file) => {
        const state = evidence?.get(`${record.id}:${file.path}`)
        return state ? { ...file, commit: state.commit ?? file.commit, uncommitted: state.uncommitted } : file
      })
      // Commit identity is durable, so a restart does not rediscover every
      // historical patch. Working-tree status stays computed, never persisted.
      if (files.length !== record.files.length || files.some((file, index) => file.commit?.hash !== record.files[index]?.commit?.hash)) {
        const target = path.join(folder, `${record.id}.json`)
        if (files.length) await writeJsonAtomic(target, encode({ ...record, files: files.map(({ uncommitted: _live, ...file }) => file) }))
        else await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
        entries.delete(target)
        listings.delete(cwd)
        loaded.delete(cwd)
      }
      if (files.length) retained.push({ ...record, files })
    }

    const snapshot = snapshotOf(retained)
    snapshots.set(cwd, snapshot)
    return snapshot
  }
  const readShared = async (cwd: string, knownRevision?: string): Promise<StoredChangesSnapshot> => {
    cwd = canonical(cwd)
    let current = reading.get(cwd)
    if (!current) {
      current = { version: versions.get(cwd) ?? 0, task: readChanges(cwd) }
      reading.set(cwd, current)
    }
    const { task, version } = current
    try {
      const snapshot = await task
      // A hook saved an edit during this read: join one fresh pass instead of
      // allowing a post-ingestion reader to consume the older snapshot.
      if (version !== (versions.get(cwd) ?? 0)) {
        if (reading.get(cwd) === current) reading.delete(cwd)
        return readShared(cwd, knownRevision)
      }
      return knownRevision === snapshot.revision ? { revision: snapshot.revision } : snapshot
    } finally { if (reading.get(cwd) === current) reading.delete(cwd) }
  }

  const list = async (cwd: string) => (await readShared(cwd)).records!
  const identity = (agentId: AgentId, sessionId: string, turnId: string, eventId: string) =>
    hash(JSON.stringify([agentId, sessionId, turnId, eventId]))

  return {
    cached(cwd: string) { return snapshots.get(canonical(cwd)) },
    onChange(listener: (cwd: string) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    registerTerminal(terminalId: string, terminal: AgentChangeTerminal) { terminals.set(terminalId, { ...terminal, cwd: canonical(terminal.cwd) }) },
    unregisterTerminal(terminalId: string) { terminals.delete(terminalId) },
    list,
    readChanges: readShared,
    async ingestHook(terminalId: string, agentId: AgentId, event: AgentHookEvent | null, call: AgentToolCall | null) {
      const terminal = terminals.get(terminalId)
      if (!terminal) return
      const sessionId = event?.sessionId ?? call?.sessionId
      if (!sessionId) return
      const sessionKey = JSON.stringify([agentId, sessionId])
      const explicitTurn = event?.turnId ?? call?.turnId
      if (event?.kind === 'turn-start') {
        if (!AGENT_HOOK_SPECS[agentId].repeatsTurnStart || !turns.has(sessionKey)) turns.set(sessionKey, explicitTurn ?? randomUUID())
      }
      if (event?.kind === 'turn-end' || event?.kind === 'session-end') {
        if (!explicitTurn || !turns.has(sessionKey) || turns.get(sessionKey) === explicitTurn) turns.delete(sessionKey)
        return
      }
      if (!call || call.failed) return
      const reportedCwd = event?.cwd || call.cwd
      if (reportedCwd && (!path.isAbsolute(reportedCwd) || reportedCwd.includes('\0'))) return
      const executionCwd = reportedCwd ? canonical(reportedCwd) : terminal.cwd
      const relativeCwd = path.relative(terminal.cwd, executionCwd)
      if (relativeCwd === '..' || relativeCwd.startsWith('..' + path.sep) || path.isAbsolute(relativeCwd)) return
      const files = filesFromTool(terminal.cwd, call.name, call.input, call.output, executionCwd)
      if (!files.length) return
      const baseCommit = await history?.capture(terminal.cwd, files)
      const prNumber = pullRequestNumber?.(terminal.cwd)
      const title = terminal.panelId ? panelTitle?.(terminal.panelId) : undefined
      const turnId = explicitTurn ?? turns.get(sessionKey) ?? `unscoped:${sessionId}`
      await save({ id: identity(agentId, sessionId, turnId, call.callId ?? randomUUID()), agentId, sessionId, turnId,
        parentSessionId: call.parentSessionId,
        terminalId, panelId: terminal.panelId,
        ...(terminal.panelId && title ? { panelTitles: { [terminal.panelId]: title } } : {}),
        ...(prNumber ? { prNumber } : {}),
        cwd: terminal.cwd,
        createdAt: new Date().toISOString(), files: files.map((file) => ({ ...file, ...(baseCommit ? { baseCommit } : {}) })) })
      notify(terminal.cwd)
    },
  }
}
