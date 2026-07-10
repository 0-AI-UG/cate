// =============================================================================
// sessionFiles — read-only access to pi's on-disk session store. Pi writes
// every conversation to (PI_CODING_AGENT_DIR points at <cwd>/.cate/pi-agent):
//
//   <cwd>/.cate/pi-agent/sessions/--<cwd-with-/-as-dashes>--/<timestamp>_<uuid>.jsonl
//
// Each line is a JSON entry. The first line is the session header; subsequent
// lines are either `message`, `session_info` (name), `model_change`,
// `thinking_level_change`, `compaction`, `branch_summary`, `custom`, `label`,
// etc. We parse enough to populate the sidebar and to convert a full session
// into our renderer transcript on resume.
//
// Pi owns the session schema; the list view reads only the stable fields it
// needs and leaves loading/validation of a resumed conversation to Pi itself.
// =============================================================================

import log from '../../main/logger'
import { hostSessionsDir, hostJoin } from './agentDir'
import { parseLocator, formatLocator } from '../../main/runtime/locator'
import { runtimes } from '../../main/runtime/runtimeManager'
import type { Runtime } from '../../main/runtime/types'
import type { AgentSessionListEntry } from '../../shared/types'

// Pi nests sessions under <agentDir>/sessions/<encoded-cwd>/. We validate file
// ops by this path segment (POSIX, since the daemon side is POSIX and the
// segment is the same shape on the local machine for forward-slash paths). For
// local Windows paths we also accept the native-separator form.
const SESSIONS_SEGMENT_POSIX = '/.cate/pi-agent/sessions/'
const SESSIONS_SEGMENT_NATIVE = `\\.cate\\pi-agent\\sessions\\`

interface ParsedHeader {
  id: string
  cwd: string
  timestamp: string
}

/** Stream-read enough of a .jsonl to compute the sidebar entry. Stops at the
 *  first user message (for the title) but continues scanning for the latest
 *  `session_info.sessionName`, since names can be set anywhere in the file. */
async function summarizeFile(
  runtime: Runtime,
  hostFilePath: string,
): Promise<AgentSessionListEntry | null> {
  let raw: string
  try {
    raw = await runtime.file.readFile(hostFilePath)
  } catch (err) {
    log.warn('[sessionFiles] read failed for %s: %O', hostFilePath, err)
    return null
  }

  // The FileHost contract exposes no mtime, so we key updatedAt off the session
  // header timestamp (set below). Local and remote behave identically here.
  const lines = raw.split('\n')
  let header: ParsedHeader | null = null
  let firstUserText: string | null = null
  let sessionName: string | null = null
  let messageCount = 0
  let lastModel: { provider: string; model: string } | undefined

  for (const line of lines) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) }
    catch { continue }
    const type = entry.type
    if (type === 'session' && !header) {
      header = {
        id: String(entry.id ?? ''),
        cwd: String(entry.cwd ?? ''),
        timestamp: String(entry.timestamp ?? ''),
      }
      continue
    }
    if (type === 'session_info') {
      // Pi's SessionManager walks in reverse for "current name" — we just take
      // the last one we see, equivalent for a sequential read.
      const name = entry.sessionName
      if (typeof name === 'string') sessionName = name
      continue
    }
    if (type === 'model_change') {
      const provider = entry.provider
      const modelId = entry.modelId
      if (typeof provider === 'string' && typeof modelId === 'string') {
        lastModel = { provider, model: modelId }
      }
      continue
    }
    if (type === 'message') {
      messageCount += 1
      if (firstUserText == null) {
        const msg = entry.message as Record<string, unknown> | undefined
        if (msg?.role === 'user') {
          firstUserText = extractText(msg.content)
        }
      }
    }
  }

  if (!header) return null
  const title =
    sessionName ??
    (firstUserText
      ? truncate(firstUserText.replace(/\s+/g, ' ').trim(), 64)
      : 'New chat')
  return {
    // Re-encode the host path as a locator so the renderer's load/delete calls
    // route back to the same runtime. No-op for the local runtime.
    path: formatLocator({ runtimeId: runtime.id, path: hostFilePath }),
    id: header.id,
    title: title || 'New chat',
    named: sessionName != null,
    cwd: header.cwd,
    createdAt: header.timestamp,
    updatedAt: header.timestamp,
    messageCount,
    ...(lastModel ? { lastModel } : {}),
  }
}

/** List sessions for a given workspace locator, newest first. Returns [] when
 *  the directory doesn't exist yet (a workspace pi hasn't been invoked in).
 *  Routed through the runtime so it works for local and remote hosts. */
export async function listSessions(cwd: string): Promise<AgentSessionListEntry[]> {
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  let runtime: Runtime
  try { runtime = runtimes.resolve(runtimeId) }
  catch (err) { log.warn('[sessionFiles] resolve runtime failed: %O', err); return [] }

  const dir = hostSessionsDir(runtimeId, hostCwd)
  // FileHost.readDir returns [] for a missing dir (it swallows readdir errors),
  // so the "pi never ran here" case lands as an empty list.
  const nodes = await runtime.file.readDir(dir)
  const files = nodes
    .filter((n) => !n.isDirectory && n.name.endsWith('.jsonl'))
    .map((n) => hostJoin(runtimeId, dir, n.name))
  const entries: AgentSessionListEntry[] = []
  for (const f of files) {
    const s = await summarizeFile(runtime, f)
    if (s) entries.push(s)
  }
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return entries
}

/** Refuse to touch anything that isn't a pi session file — guards delete/read.
 *  Accepts the HOST path (after parseLocator); checks the POSIX segment, or the
 *  native-separator form for local Windows paths. */
function isSessionFile(hostPath: string): boolean {
  if (!hostPath.endsWith('.jsonl')) return false
  return hostPath.includes(SESSIONS_SEGMENT_POSIX) || hostPath.includes(SESSIONS_SEGMENT_NATIVE)
}

export async function deleteSession(sessionFile: string): Promise<void> {
  const { runtimeId, path: hostPath } = parseLocator(sessionFile)
  if (!isSessionFile(hostPath)) {
    throw new Error(`Refusing to delete ${sessionFile} — not a pi session file`)
  }
  const runtime = runtimes.resolve(runtimeId)
  await runtime.file.remove(hostPath)
}

// ----------------------------------------------------------------------------
// Renderer-shape conversion — produce a UI transcript from a session file.
//
// Pi's session has many entry kinds; for the transcript we only project:
//   - message (user / assistant / toolResult / bashExecution)
//   - compaction (rendered as a system marker)
//
// The renderer's union is { user | assistant | tool | system }. We collapse
// pi's toolResult messages into the corresponding ToolMessage entry.
// ----------------------------------------------------------------------------

export interface RendererUserMessage { type: 'user'; id: string; text: string; entryId?: string; createdAt?: number }
export interface RendererAssistantMessage {
  type: 'assistant'; id: string; text: string; thinking?: string; streaming: false
  model?: string
  createdAt?: number
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total?: number }
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
}
export interface RendererToolMessage {
  type: 'tool'; id: string; toolCallId: string; name: string; args: unknown
  status: 'success' | 'error'; result?: string; error?: string
  /** Structured subagent payload preserved from pi's `details` field. Shape
   *  mirrors `SubagentDetails` in the renderer store; serialized as-is. */
  subagent?: unknown
}
export interface RendererSystemMessage { type: 'system'; id: string; text: string; kind?: 'info' | 'warning' | 'error' }
export type RendererMessage =
  | RendererUserMessage
  | RendererAssistantMessage
  | RendererToolMessage
  | RendererSystemMessage

let counter = 0
const nid = (): string => { counter += 1; return `s${counter}` }

export async function loadSessionTranscript(sessionFile: string): Promise<RendererMessage[]> {
  const { runtimeId, path: hostPath } = parseLocator(sessionFile)
  if (!isSessionFile(hostPath)) {
    throw new Error(`Refusing to read ${sessionFile} — not a pi session file`)
  }
  const runtime = runtimes.resolve(runtimeId)
  const raw = await runtime.file.readFile(hostPath)
  const out: RendererMessage[] = []
  // Map of toolCallId → index in `out` so toolResult can update in place.
  const toolIndex = new Map<string, number>()
  // Pi records the active model as separate `model_change` entries — track it
  // so we can stamp each assistant message with the model that produced it.
  let currentModel: string | undefined

  for (const line of raw.split('\n')) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) }
    catch { continue }
    const type = entry.type
    if (type === 'compaction') {
      out.push({ type: 'system', id: nid(), text: 'Context compacted.', kind: 'info' })
      continue
    }
    if (type === 'model_change') {
      const modelId = entry.modelId
      if (typeof modelId === 'string') currentModel = modelId
      continue
    }
    if (type !== 'message') continue
    const msg = entry.message as Record<string, unknown> | undefined
    if (!msg) continue
    const role = msg.role
    const entryId = typeof entry.id === 'string' ? entry.id : undefined
    const tsRaw = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
    const createdAt = tsRaw ? Date.parse(tsRaw) || undefined : undefined
    if (role === 'user') {
      const text = extractText(msg.content)
      if (text) out.push({ type: 'user', id: nid(), text, entryId, createdAt })
      continue
    }
    if (role === 'assistant') {
      const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : []
      const textParts: string[] = []
      const thinkingParts: string[] = []
      const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
        else if (block?.type === 'thinking' && typeof block.thinking === 'string') thinkingParts.push(block.thinking)
        else if (block?.type === 'toolCall') {
          toolCalls.push({
            id: String(block.id ?? ''),
            name: String(block.name ?? 'tool'),
            arguments: block.arguments,
          })
        }
      }
      const usageRaw = msg.usage as Record<string, unknown> | undefined
      const usage = usageRaw
        ? {
            input: numberOr(usageRaw.input, 0),
            output: numberOr(usageRaw.output, 0),
            cacheRead: numberOr(usageRaw.cacheRead, 0),
            cacheWrite: numberOr(usageRaw.cacheWrite, 0),
            total: numberOr((usageRaw.cost as Record<string, unknown> | undefined)?.total, undefined),
          }
        : undefined
      const stopReasonRaw = typeof msg.stopReason === 'string' ? msg.stopReason : undefined
      const stopReason =
        stopReasonRaw === 'stop' ||
        stopReasonRaw === 'length' ||
        stopReasonRaw === 'toolUse' ||
        stopReasonRaw === 'error' ||
        stopReasonRaw === 'aborted'
          ? stopReasonRaw
          : undefined
      const text = textParts.join('')
      const thinking = thinkingParts.length > 0 ? thinkingParts.join('') : undefined
      const model = typeof msg.model === 'string' ? msg.model : currentModel
      if (text || thinking) {
        out.push({
          type: 'assistant',
          id: nid(),
          text,
          ...(thinking ? { thinking } : {}),
          streaming: false,
          ...(model ? { model } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...(usage ? { usage } : {}),
          ...(stopReason ? { stopReason } : {}),
        })
      }
      for (const tc of toolCalls) {
        const idx = out.length
        out.push({
          type: 'tool',
          id: nid(),
          toolCallId: tc.id,
          name: tc.name,
          args: tc.arguments,
          status: 'success', // overwritten when toolResult arrives
        })
        if (tc.id) toolIndex.set(tc.id, idx)
      }
      continue
    }
    if (role === 'toolResult') {
      const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : ''
      const idx = toolCallId ? toolIndex.get(toolCallId) : undefined
      if (idx == null) continue
      const tool = out[idx] as RendererToolMessage
      const isError = msg.isError === true
      const text = extractText(msg.content) ?? ''
      const subagent = tool.name === 'subagent' ? normalizeSubagent(msg.details) : undefined
      out[idx] = {
        ...tool,
        status: isError ? 'error' : 'success',
        result: isError ? undefined : text,
        error: isError ? text || 'Tool reported an error' : undefined,
        ...(subagent ? { subagent } : {}),
      }
      continue
    }
    if (role === 'bashExecution') {
      // Pi's bashExecution is a side-channel input; render it as a system note
      // so the user sees what was injected into context.
      const cmd = typeof msg.command === 'string' ? msg.command : '(command)'
      out.push({ type: 'system', id: nid(), text: `bash: ${cmd}`, kind: 'info' })
      continue
    }
  }
  return out
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function numberOr<T>(v: unknown, fallback: T): number | T {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Reshape pi's persisted `details` for the subagent tool into the structure
 *  the renderer's SubagentCard expects (mirrors extractSubagentDetails in the
 *  renderer store; the live and replayed shapes must match). */
function normalizeSubagent(details: unknown): unknown {
  if (!details || typeof details !== 'object') return undefined
  const d = details as Record<string, unknown>
  const modeRaw = typeof d.mode === 'string' ? d.mode : undefined
  const mode = modeRaw === 'parallel' || modeRaw === 'chain' ? modeRaw : 'single'
  const rawResults = Array.isArray(d.results) ? (d.results as unknown[]) : []
  const results = rawResults.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const r = item as Record<string, unknown>
    const messages = Array.isArray(r.messages) ? (r.messages as unknown[]) : []
    const parts: Array<{ type: 'text' | 'toolCall'; text?: string; toolCall?: { name: string; args: unknown } }> = []
    let finalText: string | undefined
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      const mObj = m as Record<string, unknown>
      if (mObj.role !== 'assistant') continue
      const content = Array.isArray(mObj.content) ? (mObj.content as unknown[]) : []
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const p = part as Record<string, unknown>
        if (p.type === 'text' && typeof p.text === 'string' && p.text) {
          parts.push({ type: 'text', text: p.text })
          finalText = p.text
        } else if (p.type === 'toolCall') {
          parts.push({
            type: 'toolCall',
            toolCall: {
              name: typeof p.name === 'string' ? p.name : 'tool',
              args: p.arguments ?? {},
            },
          })
        }
      }
    }
    const u = r.usage as Record<string, unknown> | undefined
    const usage = u
      ? {
          input: numberOr(u.input, 0) as number,
          output: numberOr(u.output, 0) as number,
          cacheRead: numberOr(u.cacheRead, 0) as number,
          cacheWrite: numberOr(u.cacheWrite, 0) as number,
          cost: numberOr(u.cost, 0) as number,
          contextTokens: numberOr(u.contextTokens, undefined),
          turns: numberOr(u.turns, undefined),
        }
      : undefined
    return [{
      agent: typeof r.agent === 'string' ? r.agent : '(unknown)',
      agentSource: r.agentSource,
      task: typeof r.task === 'string' ? r.task : '',
      exitCode: numberOr(r.exitCode, -1) as number,
      parts,
      finalText,
      stderr: typeof r.stderr === 'string' ? r.stderr : undefined,
      errorMessage: typeof r.errorMessage === 'string' ? r.errorMessage : undefined,
      stopReason: typeof r.stopReason === 'string' ? r.stopReason : undefined,
      usage,
      model: typeof r.model === 'string' ? r.model : undefined,
      step: numberOr(r.step, undefined),
    }]
  })
  return { mode, results }
}
