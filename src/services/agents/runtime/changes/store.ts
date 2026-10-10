import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { writeJsonExclusive } from '@kernel/state/node'
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
export type StoredAgentChange = Omit<AgentChangeRecord, 'panelIds'> & {
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
 * working-tree snapshots. Each record is one immutable file, so concurrent
 * writers never overwrite each other.
 */
export function createAgentChangesStore(directory: string) {
  const canonical = (cwd: string) => { try { return realpathSync.native(cwd) } catch { return path.resolve(cwd) } }
  const terminals = new Map<string, AgentChangeTerminal>()
  const turns = new Map<string, string>()
  const queues = new Map<string, Set<Promise<void>>>()
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const folderFor = (cwd: string) => path.join(directory, hash(canonical(cwd)) + '.d')
  type Entry = { record?: StoredAgentChange }
  const entries = new Map<string, Entry>()

  const save = async (record: StoredAgentChange): Promise<void> => {
    const cwd = record.cwd
    const pending = writeJsonExclusive(path.join(folderFor(cwd), `${record.id}.json`), { record })
    const active = queues.get(cwd) ?? new Set<Promise<void>>()
    active.add(pending)
    queues.set(cwd, active)
    try { await pending } finally {
      active.delete(pending)
      if (!active.size) queues.delete(cwd)
    }
  }
  const readChanges = async (cwd: string, knownRevision?: string): Promise<StoredChangesSnapshot> => {
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
    for (const name of names) {
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
      if (entry.record && !records.has(entry.record.id)) records.set(entry.record.id, entry.record)
    }
    return { revision, records: [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) }
  }
  const list = async (cwd: string) => (await readChanges(cwd)).records!
  const identity = (agentId: AgentId, sessionId: string, turnId: string, eventId: string) =>
    hash(JSON.stringify([agentId, sessionId, turnId, eventId]))

  return {
    registerTerminal(terminalId: string, terminal: AgentChangeTerminal) { terminals.set(terminalId, { ...terminal, cwd: canonical(terminal.cwd) }) },
    unregisterTerminal(terminalId: string) { terminals.delete(terminalId) },
    list,
    readChanges,
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
      if (!call) return
      const reportedCwd = event?.cwd || call.cwd
      if (reportedCwd && (!path.isAbsolute(reportedCwd) || reportedCwd.includes('\0'))) return
      const executionCwd = reportedCwd ? canonical(reportedCwd) : terminal.cwd
      const relativeCwd = path.relative(terminal.cwd, executionCwd)
      if (relativeCwd === '..' || relativeCwd.startsWith('..' + path.sep) || path.isAbsolute(relativeCwd)) return
      const files = filesFromTool(terminal.cwd, call.name, call.input, call.output, executionCwd)
      if (!files.length) return
      const turnId = explicitTurn ?? turns.get(sessionKey) ?? `unscoped:${sessionId}`
      await save({ id: identity(agentId, sessionId, turnId, call.callId ?? randomUUID()), agentId, sessionId, turnId,
        parentSessionId: call.parentSessionId,
        terminalId, panelId: terminal.panelId, cwd: terminal.cwd,
        createdAt: new Date().toISOString(), files })
    },
  }
}
