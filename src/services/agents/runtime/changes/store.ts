import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { writeJsonExclusive } from '@kernel/state/node'
import {
  AGENT_HOOK_SPECS,
  agentIdForT3Provider,
  summarizeAgentChanges,
  type AgentChangeRecord,
  type AgentHookEvent,
  type AgentId,
  type AgentToolCall,
} from '../../contract'
import { filesFromPatch, filesFromTool, object, string } from './edits'

/** Where a hook post or T3 event with edits comes from: a terminal's PTY or a
 *  T3 harness, bound to the checkout it runs in. */
export interface AgentChangeSource { cwd: string; panelId?: string; kind: 'terminal' | 't3' }

/** A record as stored: where it came from (a terminal's PTY, or a T3 thread
 *  with the panels that showed it). The agents service resolves it to the
 *  contract's record for consumers. */
export type StoredAgentChange = Omit<AgentChangeRecord, 'panelIds'> & {
  source: 'terminal' | 't3'
  sourceId: string
  panelId?: string
  panelIds?: string[]
}

export interface StoredChangesSnapshot {
  revision: string
  records?: StoredAgentChange[]
}

export type AgentChangesStore = ReturnType<typeof createAgentChangesStore>

/**
 * Change history per checkout in `<data>/agents/changes/<sha256(cwd)>.d/`.
 * Only reported patches are saved, never raw prompts, tool output or
 * working-tree snapshots. Each record and binding is one immutable file, so
 * concurrent writers never overwrite each other; a reader compacts snapshot
 * versions it has proven superseded.
 */
export function createAgentChangesStore(directory: string) {
  const canonical = (cwd: string) => { try { return realpathSync.native(cwd) } catch { return path.resolve(cwd) } }
  const sources = new Map<string, AgentChangeSource>()
  const turns = new Map<string, string>()
  const queues = new Map<string, Set<Promise<void>>>()
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const folderFor = (cwd: string) => path.join(directory, hash(canonical(cwd)) + '.d')
  type Entry = { record: StoredAgentChange; receivedAt: number } | { threadId: string; panelId: string }
  const entries = new Map<string, Entry>()

  const publish = async (cwd: string, name: string, entry: Entry): Promise<void> => {
    const pending = writeJsonExclusive(path.join(folderFor(cwd), name), entry)
    const active = queues.get(cwd) ?? new Set<Promise<void>>()
    active.add(pending)
    queues.set(cwd, active)
    try { await pending } finally {
      active.delete(pending)
      if (!active.size) queues.delete(cwd)
    }
  }
  const save = (record: StoredAgentChange) => {
    // Provider timestamps have millisecond precision; consecutive cumulative
    // snapshots can share one timestamp. Preserve their local receipt order.
    const receivedAt = performance.timeOrigin + performance.now()
    return publish(record.cwd, `${record.id}${record.mode === 'snapshot' ? '-' + hash(JSON.stringify([record, receivedAt])) : ''}.json`, { record, receivedAt })
  }
  const readChanges = async (cwd: string, knownRevision?: string, attempt = 0): Promise<StoredChangesSnapshot> => {
    cwd = canonical(cwd)
    await Promise.all(queues.get(cwd) ?? [])
    const folder = folderFor(cwd)
    const names = (await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })).filter((name) => name.endsWith('.json')).sort()
    const revision = hash(JSON.stringify(names))
    if (knownRevision === revision) return { revision }
    const records = new Map<string, StoredAgentChange>()
    const bindings = new Map<string, Set<string>>()
    const receivedTimes = new Map<string, number>()
    const latestSnapshots = new Map<string, { file: string; record: StoredAgentChange; receivedAt: number }>()
    const superseded: string[] = []
    for (const name of names) {
      const file = path.join(folder, name)
      let entry = entries.get(file)
      if (!entry) {
        const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null // Another reader compacted a superseded snapshot.
          throw error
        })
        if (raw === null) {
          if (attempt >= 3) throw new Error('Agent change history changed while reading; retry the request')
          return readChanges(cwd, knownRevision, attempt + 1)
        }
        entry = JSON.parse(raw) as Entry
        entries.set(file, entry)
      }
      if ('record' in entry) {
        const record = entry.record
        const old = records.get(record.id)
        if (!old || (record.mode === 'snapshot' && (old.createdAt < record.createdAt
          || (old.createdAt === record.createdAt && (receivedTimes.get(record.id) ?? 0) <= entry.receivedAt)))) {
          records.set(record.id, record)
          receivedTimes.set(record.id, entry.receivedAt)
        }
        if (record.mode === 'snapshot') {
          const latest = latestSnapshots.get(record.id)
          if (!latest || latest.record.createdAt < record.createdAt
            || (latest.record.createdAt === record.createdAt && latest.receivedAt < entry.receivedAt)) {
            if (latest) superseded.push(latest.file)
            latestSnapshots.set(record.id, { file, record, receivedAt: entry.receivedAt })
          } else superseded.push(file)
        }
      } else {
        const panels = bindings.get(entry.threadId) ?? new Set<string>()
        panels.add(entry.panelId)
        bindings.set(entry.threadId, panels)
      }
    }
    // Delete only immutable versions proven older than a version already read.
    // Concurrent writers publish different paths, so this cannot delete a newer update.
    for (const file of superseded) {
      await unlink(file).catch(() => {})
      entries.delete(file)
    }
    return { revision, records: [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((record) => record.source === 't3' ? { ...record, panelIds: [...(bindings.get(record.sourceId) ?? [])].sort() } : record) }
  }
  const list = async (cwd: string) => (await readChanges(cwd)).records!
  const identity = (agentId: AgentId, sessionId: string, turnId: string, eventId: string) =>
    hash(JSON.stringify([agentId, sessionId, turnId, eventId]))

  return {
    registerSource(id: string, source: AgentChangeSource) { sources.set(id, { ...source, cwd: canonical(source.cwd) }) },
    unregisterSource(id: string) { sources.delete(id) },
    list,
    readChanges,
    bind: (cwd: string, threadId: string, panelId: string) => publish(canonical(cwd), `binding-${hash(JSON.stringify([threadId, panelId]))}.json`, { threadId, panelId }),
    async summary(sourceId: string, threadId: string, turnId: string) {
      const source = sources.get(sourceId)
      if (!source || source.kind !== 't3') throw new Error('Unknown chat change source')
      return summarizeAgentChanges((await list(source.cwd)).filter((r) => r.source === 't3' && r.sourceId === threadId && r.turnId === turnId))
    },
    async ingestHook(sourceId: string, agentId: AgentId, event: AgentHookEvent | null, call: AgentToolCall | null) {
      const source = sources.get(sourceId)
      if (!source || source.kind !== 'terminal') return
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
      if (!call) return
      const reportedCwd = event?.cwd || call.cwd
      if (reportedCwd && (!path.isAbsolute(reportedCwd) || reportedCwd.includes('\0'))) return
      const executionCwd = reportedCwd ? canonical(reportedCwd) : source.cwd
      const relativeCwd = path.relative(source.cwd, executionCwd)
      if (relativeCwd === '..' || relativeCwd.startsWith('..' + path.sep) || path.isAbsolute(relativeCwd)) return
      const files = filesFromTool(source.cwd, call.name, call.input, call.output, executionCwd)
      if (!files.length) return
      const turnId = explicitTurn ?? turns.get(sessionKey) ?? `unscoped:${sessionId}`
      await save({ id: identity(agentId, sessionId, turnId, call.callId ?? randomUUID()), agentId, sessionId, turnId,
        parentSessionId: call.parentSessionId,
        source: 'terminal', sourceId, panelId: source.panelId, cwd: source.cwd,
        createdAt: new Date().toISOString(), mode: 'operation', files })
    },
    async ingestT3(sourceId: string, value: unknown) {
      const source = sources.get(sourceId)
      if (!source || source.kind !== 't3') throw new Error('Unknown chat change source')
      const event = object(value)
      const payload = object(event.payload)
      const agentId = typeof event.provider === 'string' ? agentIdForT3Provider(event.provider) : null
      if (!agentId) return
      const threadId = string(event.threadId)
      const turnId = string(event.turnId)
      if (!threadId || !turnId) return
      const child = string(payload.agentId)
      const sessionId = child ? `${threadId}:${child}` : threadId
      const data = object(payload.data)
      const state = object(data.state)
      const snapshot = event.type === 'turn.diff.updated' && typeof payload.unifiedDiff === 'string'
      const completed = event.type === 'item.completed' && payload.status === 'completed'
      if (!snapshot && !completed) return
      const raw = object(object(event.raw).payload)
      const toolName = string(data.toolName ?? data.tool ?? payload.title) ?? ''
      const input = data.input ?? state.input ?? data.rawInput ?? (object(data.item).changes ? data.item : data)
      const output = Array.isArray(data.content) ? data : raw.tool_use_result ?? data.result ?? state.metadata ?? data.rawOutput
      const files = snapshot ? filesFromPatch(source.cwd, payload.unifiedDiff as string)
        : filesFromTool(source.cwd, toolName, input, output)
      if (!snapshot && !files.length) return
      await save({ id: identity(agentId, sessionId, turnId, snapshot ? 'snapshot' : string(event.itemId ?? event.eventId) ?? randomUUID()),
        agentId, sessionId, turnId, parentSessionId: child ? threadId : undefined,
        source: 't3', sourceId: threadId, cwd: source.cwd, createdAt: string(event.createdAt) ?? new Date().toISOString(),
        mode: snapshot ? 'snapshot' : 'operation', files })
    },
  }
}
