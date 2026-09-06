import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentId } from '../../shared/agents'
import { AGENTS } from '../../shared/agents'
import type { AgentHookEvent } from '../../shared/agentHooks'
import { summarizeAgentChanges, type AgentChangeRecord } from '../../shared/agentChanges'
import { filesFromPatch, filesFromTool, object, string } from './agentChangeEdits'

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
  const queues = new Map<string, Promise<unknown>>()
  const filename = (cwd: string) => path.join(directory, createHash('sha256').update(canonical(cwd)).digest('hex') + '.json')
  type History = { version: 1; records: AgentChangeRecord[]; bindings: Record<string, string[]> }
  const read = async (cwd: string): Promise<History> => {
    try {
      const data = JSON.parse(await readFile(filename(cwd), 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Unsupported agent change history')
      return { ...data, bindings: data.bindings ?? {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: [], bindings: {} }
      throw error // Never overwrite a corrupt history with an empty one.
    }
  }
  const mutate = async (cwd: string, change: (data: History) => boolean): Promise<void> => {
    const previous = queues.get(cwd) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const data = await read(cwd)
      if (!change(data)) return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = filename(cwd)
      const temporary = `${file}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 })
      await rename(temporary, file)
    })
    queues.set(cwd, pending)
    try { await pending } finally { if (queues.get(cwd) === pending) queues.delete(cwd) }
  }
  const save = (record: AgentChangeRecord) => mutate(record.cwd, (data) => {
    const index = data.records.findIndex((r) => r.id === record.id)
    if (index >= 0) {
      if (record.mode !== 'snapshot' || data.records[index].createdAt > record.createdAt) return false
      data.records[index] = record
    } else data.records.push(record)
    return true
  })
  const list = async (cwd: string) => {
    cwd = canonical(cwd)
    await queues.get(cwd)
    const data = await read(cwd)
    return data.records.map((record) => record.source === 't3' ? { ...record, panelIds: Object.hasOwn(data.bindings, record.sourceId) ? data.bindings[record.sourceId] : [] } : record)
  }
  const identity = (agentId: AgentId, sessionId: string, turnId: string, eventId: string) =>
    createHash('sha256').update(JSON.stringify([agentId, sessionId, turnId, eventId])).digest('hex')

  return {
    registerSource(id: string, source: AgentChangeSource) { sources.set(id, { ...source, cwd: canonical(source.cwd) }) },
    unregisterSource(id: string) { sources.delete(id) },
    list,
    bind: (cwd: string, threadId: string, panelId: string) => mutate(canonical(cwd), (data) => {
      const panels = Object.hasOwn(data.bindings, threadId) ? data.bindings[threadId] : []
      if (panels.includes(panelId)) return false
      data.bindings = { ...data.bindings, [threadId]: [...panels, panelId] }
      return true
    }),
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
      const part = object(raw.part)
      const partState = object(part.state)
      const completed = /^(PostToolUse|postToolUse|post_tool_use)$/.test(name)
        || (name === 'message.part.updated' && part.type === 'tool' && partState.status === 'completed')
      if (!completed) return
      const output = raw.tool_response ?? raw.toolResponse ?? raw.tool_output ?? raw.result ?? partState.metadata
      if (object(output).is_error === true || object(output).success === false || raw.success === false
        || ['error', 'failed', 'declined'].includes(String(object(output).status ?? raw.status))) return
      const toolName = string(raw.tool_name ?? raw.toolName ?? part.tool) ?? ''
      const input = raw.tool_input ?? raw.toolInput ?? raw.input ?? partState.input
      const files = filesFromTool(source.cwd, toolName, input, output)
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
