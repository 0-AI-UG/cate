// =============================================================================
// Agent Store — per-panel state for Pi coding-agent panels.
//
// Subscribes once to window.electronAPI.onAgentEvent / onAgentToolRequest and
// routes events to the matching panel's slice. Each panel owns:
//   • a list of UI messages (user / assistant / tool / system)
//   • current model + running flag
//   • pending tool-call approval requests
//   • session stats (tokens / cost / context usage)
//   • transient compaction / auto-retry state
//   • pending extension-UI dialog requests
//
// The renderer narrows pi's event shape defensively — unknown event types are
// ignored silently.
// =============================================================================

import { create } from 'zustand'
import log from '../../renderer/lib/logger'
import type {
  AgentExtensionUIRequest,
  AgentImageAttachment,
  AgentModelRef,
  AgentSessionStats,
  AgentThinkingLevel,
  AgentToolApprovalRequest,
} from '../../shared/types'

// -----------------------------------------------------------------------------
// Message types — local to the renderer
// -----------------------------------------------------------------------------

export interface DiffInfo {
  path: string
  before?: string
  after?: string
  oldString?: string
  newString?: string
  /** Multi-edit shape — one entry per find/replace block in the same file. */
  edits?: Array<{ oldString: string; newString: string }>
}

/** Tool names whose argument shape we know how to render as a diff. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'edit', 'write', 'multi_edit', 'multiedit', 'multiEdit', 'MultiEdit',
  'str_replace', 'str_replace_based_edit_tool', 'str_replace_editor',
  'apply_patch', 'edit_file', 'editFile',
])

export function isEditToolName(name: string): boolean {
  return EDIT_TOOL_NAMES.has(name)
}

export type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'denied'

export interface UserMessage {
  type: 'user'
  id: string
  text: string
  /** Pi entryId — populated when the message comes from pi's session, used
   *  for fork operations. Absent for messages we synthesized locally before
   *  pi has assigned one. */
  entryId?: string
  /** Wall-clock ms when the message was sent. */
  createdAt?: number
}

export interface AssistantMessage {
  type: 'assistant'
  id: string
  text: string
  thinking?: string
  streaming: boolean
  /** Model id that generated this message (captured when the turn started). */
  model?: string
  /** Wall-clock ms when the turn started. */
  createdAt?: number
  /** Per-turn usage attached on message_end. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total?: number }
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
}

export interface ToolMessage {
  type: 'tool'
  id: string
  toolCallId: string
  name: string
  args: unknown
  status: ToolStatus
  /** Streaming/final result content. We render the live `partialText` while
   *  status === 'running' and the `result` once it lands. */
  partialText?: string
  result?: string
  error?: string
  diff?: DiffInfo
  /** Structured details for tools that emit them (currently: subagent). */
  subagent?: SubagentDetails
}

/** Mirrors the SubagentDetails shape emitted by pi's subagent extension —
 *  see ~/.pi/agent/extensions/subagent/index.ts. We narrow defensively. */
export interface SubagentUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens?: number
  turns?: number
}

export interface SubagentToolCall {
  name: string
  args: Record<string, unknown>
}

export interface SubagentMessagePart {
  type: 'text' | 'toolCall'
  text?: string
  toolCall?: SubagentToolCall
}

export interface SubagentResult {
  agent: string
  agentSource?: 'user' | 'project' | 'unknown'
  task: string
  /** -1 = still running, 0 = success, >0 = error. */
  exitCode: number
  parts: SubagentMessagePart[]
  finalText?: string
  stderr?: string
  errorMessage?: string
  stopReason?: string
  usage?: SubagentUsage
  model?: string
  step?: number
}

export interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain'
  results: SubagentResult[]
}

export interface SystemMessage {
  type: 'system'
  id: string
  text: string
  /** Sub-kind so the UI can style differently. */
  kind?: 'info' | 'warning' | 'error'
}

export type AgentMessage = UserMessage | AssistantMessage | ToolMessage | SystemMessage

// -----------------------------------------------------------------------------
// Transient state — compaction + auto-retry banners, status/widget/notify
// payloads emitted by extensions, and pending dialog UI requests.
// -----------------------------------------------------------------------------

export interface CompactionState {
  active: boolean
  reason?: 'manual' | 'threshold' | 'overflow'
  lastResult?: { summary?: string; tokensBefore?: number }
  lastErrorMessage?: string
}

export interface RetryState {
  active: boolean
  attempt?: number
  maxAttempts?: number
  delayMs?: number
  errorMessage?: string
  finalError?: string
  succeededOnAttempt?: number
}

export interface ExtensionStatusEntry {
  key: string
  text: string
}

export interface ExtensionWidgetEntry {
  key: string
  lines: string[]
  placement: 'aboveEditor' | 'belowEditor'
}


// -----------------------------------------------------------------------------
// Per-panel state
// -----------------------------------------------------------------------------

export interface PanelAgentState {
  messages: AgentMessage[]
  running: boolean
  model: AgentModelRef | null
  pendingApprovals: AgentToolApprovalRequest[]
  stats: AgentSessionStats | null
  thinkingLevel: AgentThinkingLevel | null
  autoCompactionEnabled: boolean
  autoRetryEnabled: boolean
  compaction: CompactionState
  retry: RetryState
  steeringQueue: string[]
  followUpQueue: string[]
  extensionStatuses: ExtensionStatusEntry[]
  extensionWidgets: ExtensionWidgetEntry[]

  /** Pending dialog requests from pi extensions — rendered as in-panel UI. */
  uiRequests: AgentExtensionUIRequest[]
  /** Optional session display name (mirrors pi's `set_session_name`). */
  sessionName?: string
  sessionFile?: string

  /** Unsent composer contents for this chat. Kept per-slice so switching
   *  between open chats preserves each chat's in-progress message + images
   *  rather than sharing one draft across all of them. */
  draft: string
  draftImages: AgentImageAttachment[]
}

interface AgentStoreState {
  panels: Record<string, PanelAgentState>
}

interface AgentStoreActions {
  init: (panelId: string) => void
  dispose: (panelId: string) => void
  appendUser: (panelId: string, text: string) => void
  beginAssistant: (panelId: string) => void
  appendAssistantDelta: (panelId: string, delta: string) => void
  appendAssistantThinking: (panelId: string, delta: string) => void
  endAssistant: (
    panelId: string,
    extras?: { usage?: AssistantMessage['usage']; stopReason?: AssistantMessage['stopReason'] },
  ) => void
  addToolCall: (panelId: string, toolCallId: string, name: string, args: unknown) => void
  updateToolCall: (panelId: string, toolCallId: string, patch: Partial<Omit<ToolMessage, 'type' | 'id' | 'toolCallId'>>) => void
  setRunning: (panelId: string, running: boolean) => void
  setModel: (panelId: string, model: AgentModelRef | null) => void
  addApproval: (panelId: string, req: AgentToolApprovalRequest) => void
  resolveApproval: (panelId: string, toolCallId: string) => void
  appendSystem: (panelId: string, text: string, kind?: SystemMessage['kind']) => void
  loadMessages: (panelId: string, messages: AgentMessage[]) => void
  clearMessages: (panelId: string) => void
  setStats: (panelId: string, stats: AgentSessionStats | null) => void
  setThinkingLevel: (panelId: string, level: AgentThinkingLevel) => void
  setAutoCompactionEnabled: (panelId: string, enabled: boolean) => void
  setAutoRetryEnabled: (panelId: string, enabled: boolean) => void
  setSessionMeta: (panelId: string, meta: { sessionName?: string; sessionFile?: string }) => void
  setDraft: (panelId: string, draft: string) => void
  setDraftImages: (panelId: string, images: AgentImageAttachment[]) => void
  setCompaction: (panelId: string, next: Partial<CompactionState>) => void
  setRetry: (panelId: string, next: Partial<RetryState>) => void
  setQueues: (panelId: string, steering: string[], followUp: string[]) => void
  setExtensionStatus: (panelId: string, key: string, text?: string) => void
  setExtensionWidget: (
    panelId: string,
    key: string,
    lines: string[] | undefined,
    placement: 'aboveEditor' | 'belowEditor',
  ) => void

  addUiRequest: (panelId: string, req: AgentExtensionUIRequest) => void
  resolveUiRequest: (panelId: string, id: string) => void
}

export type AgentStore = AgentStoreState & AgentStoreActions

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let msgIdCounter = 0
function nextMsgId(): string {
  msgIdCounter += 1
  return `m${msgIdCounter}`
}

function emptyPanel(): PanelAgentState {
  return {
    messages: [],
    running: false,
    model: null,
    pendingApprovals: [],
    stats: null,
    thinkingLevel: null,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    compaction: { active: false },
    retry: { active: false },
    steeringQueue: [],
    followUpQueue: [],
    extensionStatuses: [],
    extensionWidgets: [],
    uiRequests: [],
    draft: '',
    draftImages: [],
  }
}

function withPanel(
  state: AgentStoreState,
  panelId: string,
  mutate: (p: PanelAgentState) => PanelAgentState,
): AgentStoreState {
  const current = state.panels[panelId]
  if (!current) return state
  const next = mutate(current)
  if (next === current) return state
  return { panels: { ...state.panels, [panelId]: next } }
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useAgentStore = create<AgentStore>((set) => ({
  panels: {},

  init(panelId) {
    set((state) => {
      if (state.panels[panelId]) return state
      return { panels: { ...state.panels, [panelId]: emptyPanel() } }
    })
  },

  dispose(panelId) {
    set((state) => {
      if (!state.panels[panelId]) return state
      const next = { ...state.panels }
      delete next[panelId]
      return { panels: next }
    })
  },

  appendUser(panelId, text) {
    set((state) =>
      withPanel(state, panelId, (p) => ({
        ...p,
        messages: [...p.messages, { type: 'user', id: nextMsgId(), text, createdAt: Date.now() }],
      })),
    )
  },

  appendSystem(panelId, text, kind = 'info') {
    set((state) =>
      withPanel(state, panelId, (p) => ({
        ...p,
        messages: [...p.messages, { type: 'system', id: nextMsgId(), text, kind }],
      })),
    )
  },

  beginAssistant(panelId) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        const last = p.messages[p.messages.length - 1]
        if (last && last.type === 'assistant' && last.streaming) return p
        return {
          ...p,
          messages: [
            ...p.messages,
            { type: 'assistant', id: nextMsgId(), text: '', streaming: true, model: p.model?.model, createdAt: Date.now() },
          ],
        }
      }),
    )
  },

  appendAssistantDelta(panelId, delta) {
    if (!delta) return
    set((state) =>
      withPanel(state, panelId, (p) => {
        const msgs = p.messages.slice()
        let last = msgs[msgs.length - 1]
        if (!last || last.type !== 'assistant' || !last.streaming) {
          last = { type: 'assistant', id: nextMsgId(), text: '', streaming: true, model: p.model?.model, createdAt: Date.now() }
          msgs.push(last)
        }
        const cur = last as AssistantMessage
        msgs[msgs.length - 1] = { ...cur, text: cur.text + delta }
        return { ...p, messages: msgs }
      }),
    )
  },

  appendAssistantThinking(panelId, delta) {
    if (!delta) return
    set((state) =>
      withPanel(state, panelId, (p) => {
        const msgs = p.messages.slice()
        let last = msgs[msgs.length - 1]
        if (!last || last.type !== 'assistant' || !last.streaming) {
          last = { type: 'assistant', id: nextMsgId(), text: '', streaming: true, model: p.model?.model, createdAt: Date.now() }
          msgs.push(last)
        }
        const cur = last as AssistantMessage
        msgs[msgs.length - 1] = { ...cur, thinking: (cur.thinking ?? '') + delta }
        return { ...p, messages: msgs }
      }),
    )
  },

  endAssistant(panelId, extras) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        const msgs = p.messages.slice()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          if (m.type === 'assistant' && m.streaming) {
            msgs[i] = {
              ...m,
              streaming: false,
              ...(extras?.usage ? { usage: extras.usage } : {}),
              ...(extras?.stopReason ? { stopReason: extras.stopReason } : {}),
            }
            break
          }
        }
        return { ...p, messages: msgs }
      }),
    )
  },

  addToolCall(panelId, toolCallId, name, args) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        if (p.messages.some((m) => m.type === 'tool' && m.toolCallId === toolCallId)) return p
        const msg: ToolMessage = {
          type: 'tool',
          id: nextMsgId(),
          toolCallId,
          name,
          args,
          status: 'pending',
        }
        return { ...p, messages: [...p.messages, msg] }
      }),
    )
  },

  updateToolCall(panelId, toolCallId, patch) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        const idx = p.messages.findIndex(
          (m) => m.type === 'tool' && m.toolCallId === toolCallId,
        )
        if (idx < 0) return p
        const msgs = p.messages.slice()
        const existing = msgs[idx] as ToolMessage
        msgs[idx] = { ...existing, ...patch }
        return { ...p, messages: msgs }
      }),
    )
  },

  setRunning(panelId, running) {
    set((state) => withPanel(state, panelId, (p) => (p.running === running ? p : { ...p, running })))
  },

  setModel(panelId, model) {
    set((state) => withPanel(state, panelId, (p) => ({ ...p, model })))
  },

  addApproval(panelId, req) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        if (p.pendingApprovals.some((r) => r.toolCallId === req.toolCallId)) return p
        return { ...p, pendingApprovals: [...p.pendingApprovals, req] }
      }),
    )
  },

  loadMessages(panelId, messages) {
    set((state) =>
      withPanel(state, panelId, (p) => ({ ...p, messages: messages.slice() })),
    )
  },

  clearMessages(panelId) {
    set((state) =>
      withPanel(state, panelId, (p) => ({
        ...p,
        messages: [],
        pendingApprovals: [],
        stats: null,
        compaction: { active: false },
        retry: { active: false },
        steeringQueue: [],
        followUpQueue: [],
        extensionStatuses: [],
        extensionWidgets: [],
        uiRequests: [],
      })),
    )
  },

  resolveApproval(panelId, toolCallId) {
    set((state) =>
      withPanel(state, panelId, (p) => ({
        ...p,
        pendingApprovals: p.pendingApprovals.filter((r) => r.toolCallId !== toolCallId),
      })),
    )
  },

  setStats(panelId, stats) {
    set((state) => withPanel(state, panelId, (p) => ({ ...p, stats })))
  },

  setThinkingLevel(panelId, level) {
    set((state) => withPanel(state, panelId, (p) => ({ ...p, thinkingLevel: level })))
  },

  setAutoCompactionEnabled(panelId, enabled) {
    set((state) =>
      withPanel(state, panelId, (p) =>
        p.autoCompactionEnabled === enabled ? p : { ...p, autoCompactionEnabled: enabled },
      ),
    )
  },

  setAutoRetryEnabled(panelId, enabled) {
    set((state) =>
      withPanel(state, panelId, (p) =>
        p.autoRetryEnabled === enabled ? p : { ...p, autoRetryEnabled: enabled },
      ),
    )
  },

  setSessionMeta(panelId, meta) {
    set((state) =>
      withPanel(state, panelId, (p) => ({
        ...p,
        sessionName: meta.sessionName ?? p.sessionName,
        sessionFile: meta.sessionFile ?? p.sessionFile,
      })),
    )
  },

  setDraft(panelId, draft) {
    set((state) =>
      withPanel(state, panelId, (p) => (p.draft === draft ? p : { ...p, draft })),
    )
  },

  setDraftImages(panelId, images) {
    set((state) => withPanel(state, panelId, (p) => ({ ...p, draftImages: images })))
  },

  setCompaction(panelId, next) {
    set((state) =>
      withPanel(state, panelId, (p) => ({ ...p, compaction: { ...p.compaction, ...next } })),
    )
  },

  setRetry(panelId, next) {
    set((state) => withPanel(state, panelId, (p) => ({ ...p, retry: { ...p.retry, ...next } })))
  },

  setQueues(panelId, steering, followUp) {
    set((state) =>
      withPanel(state, panelId, (p) => ({
        ...p,
        steeringQueue: steering.slice(),
        followUpQueue: followUp.slice(),
      })),
    )
  },

  setExtensionStatus(panelId, key, text) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        const filtered = p.extensionStatuses.filter((s) => s.key !== key)
        if (!text) return { ...p, extensionStatuses: filtered }
        return { ...p, extensionStatuses: [...filtered, { key, text }] }
      }),
    )
  },

  setExtensionWidget(panelId, key, lines, placement) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        const filtered = p.extensionWidgets.filter((w) => w.key !== key)
        if (!lines) return { ...p, extensionWidgets: filtered }
        return { ...p, extensionWidgets: [...filtered, { key, lines, placement }] }
      }),
    )
  },


  addUiRequest(panelId, req) {
    set((state) =>
      withPanel(state, panelId, (p) => {
        if (p.uiRequests.some((r) => r.id === req.id)) return p
        return { ...p, uiRequests: [...p.uiRequests, req] }
      }),
    )
  },

  resolveUiRequest(panelId, id) {
    set((state) =>
      withPanel(state, panelId, (p) => ({
        ...p,
        uiRequests: p.uiRequests.filter((r) => r.id !== id),
      })),
    )
  },

}))

// -----------------------------------------------------------------------------
// Module-level event subscription — wired once on first store use.
// -----------------------------------------------------------------------------

let eventSubscribed = false

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Pi tool-execution `partialResult` / `result` use a `{ content: [{type, text}] }` shape.
 *  Pull text out of the array, joining if there are multiple blocks. */
function extractContentText(v: unknown): string | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return undefined
  const obj = v as Record<string, unknown>
  const content = obj.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      const text = asString(b.text)
      if (text) parts.push(text)
    }
    if (parts.length > 0) return parts.join('')
  }
  // Some shapes are { text: '…' } directly
  const direct = asString(obj.text)
  if (direct) return direct
  return undefined
}

function extractSubagentDetails(v: unknown): SubagentDetails | undefined {
  if (!v || typeof v !== 'object') return undefined
  const root = v as Record<string, unknown>
  const details = root.details
  if (!details || typeof details !== 'object') return undefined
  const d = details as Record<string, unknown>
  const modeRaw = asString(d.mode)
  const mode: SubagentDetails['mode'] =
    modeRaw === 'parallel' || modeRaw === 'chain' ? modeRaw : 'single'
  const rawResults = Array.isArray(d.results) ? (d.results as unknown[]) : []
  const results: SubagentResult[] = []
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const agent = asString(r.agent) ?? '(unknown)'
    const task = asString(r.task) ?? ''
    const exitCode = asNumber(r.exitCode) ?? -1
    const messages = Array.isArray(r.messages) ? (r.messages as unknown[]) : []
    const parts: SubagentMessagePart[] = []
    let finalText: string | undefined
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      const mObj = m as Record<string, unknown>
      if (asString(mObj.role) !== 'assistant') continue
      const content = Array.isArray(mObj.content) ? (mObj.content as unknown[]) : []
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const p = part as Record<string, unknown>
        const t = asString(p.type)
        if (t === 'text') {
          const text = asString(p.text) ?? ''
          if (text) {
            parts.push({ type: 'text', text })
            finalText = text
          }
        } else if (t === 'toolCall') {
          const name = asString(p.name) ?? 'tool'
          const args = (p.arguments && typeof p.arguments === 'object'
            ? (p.arguments as Record<string, unknown>)
            : {}) as Record<string, unknown>
          parts.push({ type: 'toolCall', toolCall: { name, args } })
        }
      }
    }
    const usageRaw = r.usage as Record<string, unknown> | undefined
    const usage: SubagentUsage | undefined = usageRaw
      ? {
          input: asNumber(usageRaw.input) ?? 0,
          output: asNumber(usageRaw.output) ?? 0,
          cacheRead: asNumber(usageRaw.cacheRead) ?? 0,
          cacheWrite: asNumber(usageRaw.cacheWrite) ?? 0,
          cost: asNumber(usageRaw.cost) ?? 0,
          contextTokens: asNumber(usageRaw.contextTokens),
          turns: asNumber(usageRaw.turns),
        }
      : undefined
    const agentSourceRaw = asString(r.agentSource)
    const agentSource: SubagentResult['agentSource'] =
      agentSourceRaw === 'user' || agentSourceRaw === 'project' || agentSourceRaw === 'unknown'
        ? agentSourceRaw
        : undefined
    results.push({
      agent,
      agentSource,
      task,
      exitCode,
      parts,
      finalText,
      stderr: asString(r.stderr),
      errorMessage: asString(r.errorMessage),
      stopReason: asString(r.stopReason),
      usage,
      model: asString(r.model),
      step: asNumber(r.step),
    })
  }
  return { mode, results }
}

/** Best-effort parse of a tool's args — pi normally hands us objects but the
 *  occasional code path passes a JSON-encoded string. */
function coerceArgs(args: unknown): Record<string, unknown> {
  if (args == null) return {}
  if (typeof args === 'string') {
    try { return JSON.parse(args) as Record<string, unknown> } catch { return {} }
  }
  if (typeof args === 'object') return args as Record<string, unknown>
  return {}
}

export function deriveDiff(name: string, args: unknown, result?: string): DiffInfo | undefined {
  if (!isEditToolName(name)) return undefined
  const a = coerceArgs(args)
  const path = asString(a.path) ?? asString(a.file_path) ?? asString(a.file) ?? '(unknown)'
  if (name === 'write') {
    return { path, after: asString(a.content) ?? asString(a.text) ?? result ?? '' }
  }
  // Multi-edit shape: { edits: [{ oldText/old_string, newText/new_string }, …] }
  if (Array.isArray(a.edits)) {
    const edits: Array<{ oldString: string; newString: string }> = []
    for (const e of a.edits) {
      if (!e || typeof e !== 'object') continue
      const r = e as Record<string, unknown>
      const oldString =
        asString(r.oldText) ?? asString(r.old_string) ?? asString(r.oldString) ?? asString(r.search) ?? ''
      const newString =
        asString(r.newText) ?? asString(r.new_string) ?? asString(r.newString) ?? asString(r.replace) ?? ''
      if (oldString || newString) edits.push({ oldString, newString })
    }
    if (edits.length > 0) return { path, edits }
  }
  // Single-edit shape
  const oldString =
    asString(a.old_string) ?? asString(a.oldString) ?? asString(a.oldText) ?? asString(a.search)
  const newString =
    asString(a.new_string) ?? asString(a.newString) ?? asString(a.newText) ?? asString(a.replace)
  if (oldString != null || newString != null) {
    return { path, oldString, newString }
  }
  return undefined
}

function handleEvent(panelId: string, event: { type: string; [key: string]: unknown }): void {
  const store = useAgentStore.getState()
  if (!store.panels[panelId]) {
    useAgentStore.setState((state) => ({ panels: { ...state.panels, [panelId]: emptyPanel() } }))
  }

  if (typeof event.type !== 'string') return

  try {
    switch (event.type) {
      case 'agent_start':
      case 'turn_start': {
        useAgentStore.getState().setRunning(panelId, true)
        return
      }
      case 'agent_end':
      case 'turn_end': {
        useAgentStore.getState().endAssistant(panelId)
        useAgentStore.getState().setRunning(panelId, false)
        return
      }
      case 'message_start': {
        const msg = (event.message ?? {}) as Record<string, unknown>
        const role = asString(msg.role)
        if (role === 'assistant') {
          useAgentStore.getState().beginAssistant(panelId)
        }
        return
      }
      case 'message_update': {
        const ame = event.assistantMessageEvent as Record<string, unknown> | undefined
        if (ame) {
          const t = asString(ame.type)
          if (t === 'text_delta' || t === 'output_text_delta') {
            const delta = asString(ame.delta) ?? asString(ame.text) ?? ''
            useAgentStore.getState().appendAssistantDelta(panelId, delta)
            return
          }
          if (t === 'thinking_delta' || t === 'reasoning_delta') {
            const delta = asString(ame.delta) ?? asString(ame.text) ?? ''
            useAgentStore.getState().appendAssistantThinking(panelId, delta)
            return
          }
          // text_start/end, thinking_start/end, toolcall_start/delta/end, done, error
          // are all handled implicitly via tool_execution_* and message_end.
        }
        // Anthropic-style fallback
        const delta = (event.delta as Record<string, unknown> | undefined) ?? undefined
        if (delta) {
          const text = asString(delta.text)
          if (text) useAgentStore.getState().appendAssistantDelta(panelId, text)
        }
        return
      }
      case 'message_end': {
        const msg = (event.message ?? {}) as Record<string, unknown>
        const usageRaw = msg.usage as Record<string, unknown> | undefined
        const usage = usageRaw
          ? {
              input: asNumber(usageRaw.input) ?? 0,
              output: asNumber(usageRaw.output) ?? 0,
              cacheRead: asNumber(usageRaw.cacheRead) ?? 0,
              cacheWrite: asNumber(usageRaw.cacheWrite) ?? 0,
              total: asNumber((usageRaw.cost as Record<string, unknown> | undefined)?.total),
            }
          : undefined
        const stopReasonRaw = asString(msg.stopReason)
        const stopReason =
          stopReasonRaw === 'stop' ||
          stopReasonRaw === 'length' ||
          stopReasonRaw === 'toolUse' ||
          stopReasonRaw === 'error' ||
          stopReasonRaw === 'aborted'
            ? stopReasonRaw
            : undefined
        useAgentStore.getState().endAssistant(panelId, { usage, stopReason })
        return
      }
      case 'tool_execution_start': {
        const toolCallId = asString(event.toolCallId) ?? asString(event.id) ?? ''
        const name = asString(event.toolName) ?? asString(event.name) ?? 'tool'
        const args = event.args ?? event.input ?? {}
        if (!toolCallId) return
        useAgentStore.getState().addToolCall(panelId, toolCallId, name, args)
        useAgentStore.getState().updateToolCall(panelId, toolCallId, { status: 'running' })
        return
      }
      case 'tool_execution_update': {
        const toolCallId = asString(event.toolCallId) ?? asString(event.id) ?? ''
        if (!toolCallId) return
        const slice = useAgentStore.getState().panels[panelId]
        const toolMsg = slice?.messages.find(
          (m) => m.type === 'tool' && m.toolCallId === toolCallId,
        ) as ToolMessage | undefined
        const patch: Partial<ToolMessage> = {}
        const partial = extractContentText(event.partialResult)
        if (partial !== undefined) patch.partialText = partial
        if (toolMsg?.name === 'subagent') {
          const sub = extractSubagentDetails(event.partialResult)
          if (sub) patch.subagent = sub
        }
        if (Object.keys(patch).length > 0) {
          useAgentStore.getState().updateToolCall(panelId, toolCallId, patch)
        }
        return
      }
      case 'tool_execution_end': {
        const toolCallId = asString(event.toolCallId) ?? asString(event.id) ?? ''
        if (!toolCallId) return
        const error = asString(event.error)
        const isError = event.isError === true || !!error
        const result =
          extractContentText(event.result) ??
          (isError ? undefined : JSON.stringify(event.result ?? null))
        const slice = useAgentStore.getState().panels[panelId]
        const toolMsg = slice?.messages.find(
          (m) => m.type === 'tool' && m.toolCallId === toolCallId,
        ) as ToolMessage | undefined
        const diff = toolMsg && !isError ? deriveDiff(toolMsg.name, toolMsg.args, result) : undefined
        const sub = toolMsg?.name === 'subagent' ? extractSubagentDetails(event.result) : undefined
        useAgentStore.getState().updateToolCall(panelId, toolCallId, {
          status: isError ? 'error' : 'success',
          result,
          partialText: undefined,
          error: error ?? (isError ? 'Tool reported an error' : undefined),
          ...(diff ? { diff } : {}),
          ...(sub ? { subagent: sub } : {}),
        })
        return
      }
      case 'queue_update': {
        const steering = Array.isArray(event.steering) ? (event.steering as string[]) : []
        const followUp = Array.isArray(event.followUp) ? (event.followUp as string[]) : []
        useAgentStore.getState().setQueues(panelId, steering, followUp)
        return
      }
      case 'compaction_start': {
        const reason = asString(event.reason) as CompactionState['reason']
        useAgentStore.getState().setCompaction(panelId, { active: true, reason })
        return
      }
      case 'compaction_end': {
        const reason = asString(event.reason) as CompactionState['reason']
        const result = event.result as Record<string, unknown> | null
        const errorMessage = asString(event.errorMessage)
        useAgentStore.getState().setCompaction(panelId, {
          active: false,
          reason,
          lastResult: result
            ? {
                summary: asString(result.summary),
                tokensBefore: asNumber(result.tokensBefore),
              }
            : undefined,
          lastErrorMessage: errorMessage,
        })
        return
      }
      case 'auto_retry_start': {
        useAgentStore.getState().setRetry(panelId, {
          active: true,
          attempt: asNumber(event.attempt),
          maxAttempts: asNumber(event.maxAttempts),
          delayMs: asNumber(event.delayMs),
          errorMessage: asString(event.errorMessage),
          finalError: undefined,
          succeededOnAttempt: undefined,
        })
        return
      }
      case 'auto_retry_end': {
        const success = event.success === true
        useAgentStore.getState().setRetry(panelId, {
          active: false,
          succeededOnAttempt: success ? asNumber(event.attempt) : undefined,
          finalError: success ? undefined : asString(event.finalError),
        })
        return
      }
      case 'extension_error': {
        const extensionPath = asString(event.extensionPath) ?? '(unknown extension)'
        const ev = asString(event.event) ?? 'event'
        const errMsg = asString(event.error) ?? 'unknown error'
        useAgentStore
          .getState()
          .appendSystem(panelId, `Extension error (${extensionPath} during ${ev}): ${errMsg}`, 'error')
        return
      }
      case 'extension_ui_request': {
        const id = asString(event.id)
        const method = asString(event.method)
        if (!id || !method) return
        const req: AgentExtensionUIRequest = {
          id,
          method: method as AgentExtensionUIRequest['method'],
          ...event,
        }
        // Fire-and-forget methods don't expect a response — render them as
        // panel chrome (statuses / widgets / title) instead of putting them
        // in the dialog queue.
        if (method === 'notify') return
        if (method === 'setStatus') {
          const key = asString(event.statusKey) ?? 'default'
          const text = asString(event.statusText)
          useAgentStore.getState().setExtensionStatus(panelId, key, text)
          return
        }
        if (method === 'setWidget') {
          const key = asString(event.widgetKey) ?? 'default'
          const lines = Array.isArray(event.widgetLines)
            ? (event.widgetLines as string[]).filter((l) => typeof l === 'string')
            : undefined
          const placement =
            asString(event.widgetPlacement) === 'belowEditor' ? 'belowEditor' : 'aboveEditor'
          useAgentStore.getState().setExtensionWidget(panelId, key, lines, placement)
          return
        }
        if (method === 'setTitle' || method === 'set_editor_text') {
          // These are TUI-specific affordances we don't surface in the panel.
          // (set_editor_text is consumed via the AgentPanel's draft-set side
          // channel — see AgentPanel.)
          return
        }
        // Dialog methods (select / confirm / input / editor) — enqueue for the
        // panel renderer to handle inline.
        useAgentStore.getState().addUiRequest(panelId, req)
        return
      }
      case 'error': {
        const message = asString(event.message) ?? 'Agent error'
        useAgentStore.getState().appendSystem(panelId, message, 'error')
        useAgentStore.getState().setRunning(panelId, false)
        return
      }
      default:
        return
    }
  } catch (err) {
    log.warn('[agentStore] handleEvent error for %s:', event.type, err)
  }
}

function ensureSubscribed(): void {
  if (eventSubscribed) return
  if (typeof window === 'undefined' || !window.electronAPI) return
  eventSubscribed = true
  try {
    window.electronAPI.onAgentEvent((envelope) => {
      if (!envelope?.panelId || !envelope.event) return
      handleEvent(envelope.panelId, envelope.event)
    })
    window.electronAPI.onAgentToolRequest((req) => {
      if (!req?.panelId) return
      const store = useAgentStore.getState()
      if (!store.panels[req.panelId]) {
        useAgentStore.setState((state) => ({
          panels: { ...state.panels, [req.panelId]: emptyPanel() },
        }))
      }
      useAgentStore.getState().addApproval(req.panelId, req)
    })
  } catch (err) {
    log.warn('[agentStore] failed to subscribe to agent events', err)
  }
}

ensureSubscribed()
