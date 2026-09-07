import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentId } from '../../shared/agents'
import { AGENTS } from '../../shared/agents'
import type { AgentHookEvent } from '../../shared/agentHooks'
import { summarizeAgentChanges, type AgentChangeRecord } from '../../shared/agentChanges'
import { filesFromPatch, filesFromTool, object, string } from './agentChangeEdits'
import { writeJsonExclusive } from '../../shared/atomicFile'

export interface AgentChangeSource { cwd: string; panelId?: string; kind: 'terminal' | 't3' }

/** Runtime-local history, outside Git and the workspace. Only reported patches
 * are saved, never raw prompts, tool output, or working-tree snapshots. */
export function createAgentChangesStore(directory = path.join(
  process.env.CATE_E2E === '1' && process.env.CATE_E2E_USER_DATA ? process.env.CATE_E2E_USER_DATA : path.join(os.homedir(), '.cate'),
  'agent-changes',
)) {
  const canonical = (cwd: string) => { try { return realpathSync.native(cwd) } catch { return path.resolve(cwd) } }
  const sources = new Map<string, AgentChangeSource>()
  const turns = new Map<string, string>()
  const queues = new Map<string, Set<Promise<void>>>()
  const filename = (cwd: string) => path.join(directory, createHash('sha256').update(canonical(cwd)).digest('hex') + '.json')
  type History = { version: 1; records: AgentChangeRecord[]; bindings: Record<string, string[]> }
  type Entry = { record: AgentChangeRecord; receivedAt: number } | { threadId: string; panelId: string }
  const entries = new Map<string, Entry>()
  const legacy = new Map<string, { revision: string; data: History }>()
  const readLegacy = async (cwd: string): Promise<{ revision: string; data: History }> => {
    const file = filename(cwd)
    try {
      const info = await stat(file)
      const revision = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
      const cached = legacy.get(file)
      if (cached?.revision === revision) return cached
      const data = JSON.parse(await readFile(file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Unsupported agent change history')
      const result = { revision, data: { ...data, bindings: data.bindings ?? {} } as History }
      legacy.set(file, result)
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: '', data: { version: 1, records: [], bindings: {} } }
      throw error // Never overwrite a corrupt history with an empty one.
    }
  }
  const publish = async (cwd: string, name: string, entry: Entry): Promise<void> => {
    const pending = (async () => {
      await readLegacy(cwd)
      await writeJsonExclusive(path.join(filename(cwd) + '.d', name), entry)
    })()
    const active = queues.get(cwd) ?? new Set<Promise<void>>()
    active.add(pending)
    queues.set(cwd, active)
    try { await pending } finally {
      active.delete(pending)
      if (!active.size) queues.delete(cwd)
    }
  }
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const save = (record: AgentChangeRecord) => {
    // Provider timestamps have millisecond precision; consecutive cumulative
    // snapshots can share one timestamp. Preserve their local receipt order.
    const receivedAt = performance.timeOrigin + performance.now()
    return publish(record.cwd, `${record.id}${record.mode === 'snapshot' ? '-' + hash(JSON.stringify([record, receivedAt])) : ''}.json`, { record, receivedAt })
  }
  const readChanges = async (cwd: string, knownRevision?: string, attempt = 0): Promise<{ revision: string; records?: AgentChangeRecord[] }> => {
    cwd = canonical(cwd)
    await Promise.all(queues.get(cwd) ?? [])
    const previous = await readLegacy(cwd)
    const folder = filename(cwd) + '.d'
    const names = (await readdir(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[]
      throw error
    })).filter((name) => name.endsWith('.json')).sort()
    const revision = hash(JSON.stringify([previous.revision, names]))
    if (knownRevision === revision) return { revision }
    const records = new Map(previous.data.records.map((record) => [record.id, record]))
    const bindings = new Map(Object.entries(previous.data.bindings).map(([thread, panels]) => [thread, new Set(panels)]))
    const receivedTimes = new Map<string, number>()
    const latestSnapshots = new Map<string, { file: string; record: AgentChangeRecord; receivedAt: number }>()
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
    createHash('sha256').update(JSON.stringify([agentId, sessionId, turnId, eventId])).digest('hex')

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
    async ingestHook(sourceId: string, agentId: AgentId, raw: Record<string, unknown>, event: AgentHookEvent | null) {
      const source = sources.get(sourceId)
      if (!source || source.kind !== 'terminal') return
      const sessionId = event?.sessionId ?? string(raw.session_id ?? raw.sessionId ?? raw.sessionID ?? raw.conversation_id)
      if (!sessionId) return
      const sessionKey = JSON.stringify([agentId, sessionId])
      const explicitTurn = event?.turnId ?? string(raw.turn_id ?? raw.turnId ?? raw.promptId)
      if (event?.kind === 'turn-start') {
        // OpenCode repeats busy notifications during the same turn.
        if (agentId !== 'opencode' || !turns.has(sessionKey)) turns.set(sessionKey, explicitTurn ?? randomUUID())
      }
      if (event?.kind === 'turn-end' || event?.kind === 'session-end') {
        if (!explicitTurn || !turns.has(sessionKey) || turns.get(sessionKey) === explicitTurn) turns.delete(sessionKey)
        return
      }
      const name = string(raw.hook_event_name ?? raw.hookEventName ?? raw.event ?? raw.type) ?? ''
      const cursorEdit = agentId === 'cursor' && name === 'afterFileEdit'
      const part = object(raw.part)
      const partState = object(part.state)
      const completed = cursorEdit || /^(PostToolUse|postToolUse|post_tool_use)$/.test(name)
        || (name === 'message.part.updated' && part.type === 'tool' && partState.status === 'completed')
      if (!completed) return
      const output = raw.tool_response ?? raw.toolResponse ?? raw.tool_output ?? raw.result ?? partState.metadata
      if (object(output).is_error === true || object(output).success === false || raw.success === false
        || ['error', 'failed', 'declined'].includes(String(object(output).status ?? raw.status))) return
      const toolName = cursorEdit ? 'Edit' : string(raw.tool_name ?? raw.toolName ?? part.tool) ?? ''
      // Cursor emits both afterFileEdit (the before/after fragments) and a
      // generic Write completion (only new contents), without a shared ID.
      // The dedicated hook is authoritative; storing both duplicates edits.
      if (agentId === 'cursor' && !cursorEdit && toolName === 'Write') return
      const input = cursorEdit ? raw : raw.tool_input ?? raw.toolInput ?? raw.input ?? partState.input
      const reportedCwd = event?.cwd ?? string(raw.cwd ?? raw.directory)
      if (reportedCwd && (!path.isAbsolute(reportedCwd) || reportedCwd.includes('\0'))) return
      const executionCwd = reportedCwd ? canonical(reportedCwd) : source.cwd
      const relativeCwd = path.relative(source.cwd, executionCwd)
      if (relativeCwd === '..' || relativeCwd.startsWith('..' + path.sep) || path.isAbsolute(relativeCwd)) return
      const files = filesFromTool(source.cwd, toolName, input, output, executionCwd)
      if (!files.length) return
      const turnId = explicitTurn ?? turns.get(sessionKey) ?? `unscoped:${sessionId}`
      const eventId = string(raw.tool_use_id ?? raw.toolUseId ?? raw.tool_call_id ?? part.callID ?? raw.event_id) ?? randomUUID()
      await save({ id: identity(agentId, sessionId, turnId, eventId), agentId, sessionId, turnId,
        parentSessionId: string(raw.parent_session_id ?? raw.parentSessionId),
        source: 'terminal', sourceId, panelId: source.panelId, cwd: source.cwd,
        createdAt: new Date().toISOString(), mode: 'operation', files })
    },
    async ingestT3(sourceId: string, value: unknown) {
      const source = sources.get(sourceId)
      if (!source || source.kind !== 't3') throw new Error('Unknown chat change source')
      const event = object(value)
      const payload = object(event.payload)
      const provider = event.provider === 'claude' ? 'claude-code' : event.provider
      if (!AGENTS.some((agent) => agent.id === provider)) return
      const agentId = provider as AgentId
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
