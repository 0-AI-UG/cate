// =============================================================================
// ChatThread — scrolling message list for the agent panel.
//
// Renders user / assistant / tool / system messages plus any pending tool-call
// approval cards. Tool cards are collapsed by default (one-line summary) so a
// long bash output or large diff does not dominate the panel — the user
// expands what they want to see.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  CaretRight,
  CaretDown,
  CheckCircle,
  XCircle,
  Spinner,
  Wrench,
  PencilSimple,
  Terminal as TerminalIcon,
  FileText,
  MagnifyingGlass,
  Brain,
  Copy,
  Sparkle,
  ClipboardText,
} from '@phosphor-icons/react'
import type {
  AgentMessage,
  DiffInfo,
  SubagentResult,
  SubagentToolCall,
  ToolMessage,
} from './agentStore'
import { deriveDiff } from './agentStore'

interface ChatThreadProps {
  messages: AgentMessage[]
  pendingApprovals: { toolCallId: string; toolName: string; args: unknown }[]
  onApproval: (toolCallId: string, decision: 'allow' | 'deny') => void
  /** Agent is busy. Used to show a "thinking" indicator in the gap between the
   *  user's send and the first assistant token. */
  running: boolean
  /** Map of user-message id → pi entryId, used to expose "fork from here". */
  forkMap?: Record<string, string>
  onFork?: (entryId: string) => void
  /** Prefill the composer with a user message's text (no history mutation). */
  onEditResend?: (text: string) => void
  /** Plan Ready card actions — see cate-plan-mode extension. */
  onImplementPlan?: () => void
  onRefinePlan?: (text: string) => void
  onClearAndImplement?: () => void
}

export function ChatThread({ messages, pendingApprovals, onApproval, running, forkMap, onFork, onEditResend, onImplementPlan, onRefinePlan, onClearAndImplement }: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Show the thinking indicator whenever the agent is busy and the tail of
  // the list has no visible activity of its own. A streaming assistant
  // message with text shows a cursor blink; a streaming reasoning block has
  // its own spinner; a tool row has a header spinner — but a freshly-opened
  // assistant message with no text and no thinking yet (common when the
  // model jumps straight to a tool call — pi's toolcall_* deltas don't
  // surface in the renderer) leaves a blank gap. Dots fill it.
  const last = messages[messages.length - 1]
  const showThinking = running && (() => {
    if (!last) return true
    if (last.type !== 'assistant') return true
    if (!last.streaming) return true
    return !last.text && !last.thinking
  })()

  // Auto-scroll on new content unless the user has scrolled away from the
  // bottom — feels less like fighting the scroll position during long output.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance < 120) el.scrollTop = el.scrollHeight
  }, [messages.length, last, showThinking])

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0"
    >
      {messages.map((m, idx) => (
        <MessageRow
          key={m.id}
          msg={m}
          forkEntryId={m.type === 'user' ? (m.entryId ?? forkMap?.[m.id]) : undefined}
          onFork={onFork}
          onEditResend={onEditResend}
          onImplementPlan={onImplementPlan}
          onRefinePlan={onRefinePlan}
          onClearAndImplement={onClearAndImplement}
          isLast={idx === messages.length - 1}
        />
      ))}
      {pendingApprovals.map((req) => (
        <ApprovalCard
          key={req.toolCallId}
          req={req}
          onDecide={(decision) => onApproval(req.toolCallId, decision)}
        />
      ))}
      {showThinking && <ThinkingDots />}
    </div>
  )
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Agent is thinking">
      <span className="w-1.5 h-1.5 rounded-full bg-agent-light/80 animate-thinking-dot [animation-delay:0ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-agent-light/80 animate-thinking-dot [animation-delay:160ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-agent-light/80 animate-thinking-dot [animation-delay:320ms]" />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Messages
// -----------------------------------------------------------------------------

function MessageRow({
  msg,
  forkEntryId,
  onFork,
  onEditResend,
  onImplementPlan,
  onRefinePlan,
  onClearAndImplement,
  isLast,
}: {
  msg: AgentMessage
  forkEntryId?: string
  onFork?: (entryId: string) => void
  onEditResend?: (text: string) => void
  onImplementPlan?: () => void
  onRefinePlan?: (text: string) => void
  onClearAndImplement?: () => void
  isLast?: boolean
}) {
  if (msg.type === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] px-3.5 py-2 rounded-2xl rounded-br-md bg-agent/85 text-white text-[13px] whitespace-pre-wrap break-words shadow-sm">
          {msg.text}
        </div>
        <div className="flex items-center gap-0.5 text-muted">
          <button
            onClick={() => { void navigator.clipboard.writeText(msg.text) }}
            title="Copy message"
            className="p-1 rounded-md hover:text-primary hover:bg-white/10"
          >
            <Copy size={11} />
          </button>
          {msg.createdAt && (
            <span className="text-[10.5px] text-muted/70 ml-1">{formatTime(msg.createdAt)}</span>
          )}
        </div>
      </div>
    )
  }
  if (msg.type === 'assistant') {
    return (
      <div className="text-[13.5px] text-primary leading-relaxed space-y-1.5">
        {msg.thinking && <ThinkingBlock text={msg.thinking} streaming={msg.streaming} />}
        <div>
          <Markdown text={msg.text} />
          {msg.streaming && !msg.text && msg.thinking ? null : msg.streaming && <CursorBlink />}
        </div>
        {!msg.streaming && (
          <div className="flex items-center gap-0.5 text-muted">
            <button
              onClick={() => { void navigator.clipboard.writeText(msg.text) }}
              title="Copy message"
              className="p-1 rounded-md hover:text-primary hover:bg-white/10"
            >
              <Copy size={11} />
            </button>
            {(msg.model || msg.createdAt) && (
              <span className="text-[10.5px] text-zinc-500 ml-1">
                {msg.model}
                {msg.model && msg.createdAt ? ' · ' : ''}
                {msg.createdAt ? formatTime(msg.createdAt) : ''}
              </span>
            )}
          </div>
        )}
      </div>
    )
  }
  if (msg.type === 'system') {
    const tone =
      msg.kind === 'error'
        ? 'text-red-300'
        : msg.kind === 'warning'
        ? 'text-amber-300'
        : 'text-muted'
    return <div className={`text-center text-[11px] italic ${tone}`}>{msg.text}</div>
  }
  if (msg.type === 'tool' && msg.name === 'subagent') {
    return <SubagentCard msg={msg} />
  }
  if (msg.type === 'tool' && msg.name === 'plan_complete') {
    return (
      <PlanReadyCard
        msg={msg}
        onImplement={onImplementPlan}
        onRefine={onRefinePlan}
        onClearAndImplement={onClearAndImplement}
        stale={!isLast}
      />
    )
  }
  return <ToolCard msg={msg} />
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="text-[12px]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-left text-muted hover:text-primary"
      >
        {expanded
          ? <CaretDown size={9} className="shrink-0" />
          : <CaretRight size={9} className="shrink-0" />}
        <Brain size={11} className="text-agent-light/80 shrink-0" />
        <span>Reasoning</span>
        {streaming && <Spinner size={10} className="text-agent-light animate-spin" />}
      </button>
      {expanded && (
        <pre className="mt-1 pl-5 text-[11px] text-primary/70 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[260px] overflow-auto">
          {text}
        </pre>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Markdown rendering — tight, readable styles that match the panel chrome.
// -----------------------------------------------------------------------------

function Markdown({ text }: { text: string }) {
  return (
    <div className="agent-markdown space-y-2 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          h1: ({ children }) => <h1 className="text-[15px] font-semibold text-primary mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-[14px] font-semibold text-primary mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-[13.5px] font-semibold text-primary mt-2 mb-1">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer"
               className="text-agent-light underline decoration-agent-light/30 hover:decoration-agent-light">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-agent-light/40 pl-3 text-primary/80 italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-white/10 my-2" />,
          strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) {
              return (
                <code className={`${className ?? ''} font-mono text-[11.5px] leading-snug`} {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className="font-mono text-[11.5px] px-1 py-[1px] rounded bg-black/30 text-agent-light" {...props}>
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="rounded-md bg-black/40 border border-white/10 px-3 py-2 overflow-x-auto text-[11.5px] leading-snug">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="min-w-full text-[12px] border border-white/10 rounded-md">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="text-left px-2 py-1 border-b border-white/10 bg-white/[0.04] font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-2 py-1 border-b border-white/5 align-top">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function CursorBlink() {
  return (
    <span className="inline-block w-[2px] h-[1em] align-middle bg-primary/80 ml-0.5 animate-pulse" />
  )
}

// -----------------------------------------------------------------------------
// Tool card (collapsed by default)
// -----------------------------------------------------------------------------

const EDIT_NAMES = new Set([
  'edit', 'write', 'multi_edit', 'multiedit', 'multiEdit', 'MultiEdit',
  'str_replace', 'str_replace_based_edit_tool', 'str_replace_editor',
  'apply_patch', 'edit_file', 'editFile',
])

function toolIcon(name: string) {
  if (name === 'bash' || name === 'shell') return TerminalIcon
  if (EDIT_NAMES.has(name)) return PencilSimple
  if (name === 'read' || name === 'view') return FileText
  if (name === 'grep' || name === 'search') return MagnifyingGlass
  return Wrench
}

function toolSummary(msg: ToolMessage): string {
  const a = (msg.args ?? {}) as Record<string, unknown>
  if (EDIT_NAMES.has(msg.name)) {
    const path = (a.path as string) ?? (a.file_path as string) ?? (a.file as string) ?? ''
    return path || msg.name
  }
  if (msg.name === 'bash' || msg.name === 'shell') {
    const cmd = (a.command as string) ?? (a.cmd as string) ?? ''
    return cmd || msg.name
  }
  if (msg.name === 'read' || msg.name === 'view') {
    const path = (a.path as string) ?? (a.file_path as string) ?? ''
    const offset = typeof a.offset === 'number' ? (a.offset as number) : undefined
    const limit = typeof a.limit === 'number' ? (a.limit as number) : undefined
    if (path && offset != null && limit != null) return `${path}:${offset}-${offset + limit}`
    if (path && offset != null) return `${path}:${offset}`
    return path || msg.name
  }
  return msg.name
}

// `read` tool results often come back in `cat -n` form: `   123\tcontent`.
// Strip that prefix so our own gutter doesn't double up.
function stripCatN(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const m = l.match(/^\s*\d+\t(.*)$/)
      return m ? m[1] : l
    })
    .join('\n')
}

function CodePreview({
  text,
  startLine = 1,
  maxLines = 200,
}: {
  text: string
  startLine?: number
  maxLines?: number
}) {
  const lines = text.split('\n')
  const truncated = lines.length > maxLines
  const shown = truncated ? lines.slice(0, maxLines) : lines
  return (
    <div className="font-mono text-[11px] leading-snug max-h-[320px] overflow-auto">
      {shown.map((l, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-muted/40 select-none w-8 text-right shrink-0">{startLine + i}</span>
          <span className="whitespace-pre-wrap break-words text-primary/85 flex-1">{l || ' '}</span>
        </div>
      ))}
      {truncated && (
        <div className="text-muted text-[10.5px] mt-1 pl-10">
          … {lines.length - maxLines} more line{lines.length - maxLines === 1 ? '' : 's'}
        </div>
      )}
    </div>
  )
}

function toolVerb(msg: ToolMessage): string {
  if (msg.name === 'write') return 'Wrote'
  if (EDIT_NAMES.has(msg.name)) return 'Edited'
  switch (msg.name) {
    case 'bash':
    case 'shell':
      return 'Ran'
    case 'read':
    case 'view':
      return 'Read'
    case 'grep':
    case 'search':
      return 'Searched'
    default:
      return 'Used'
  }
}

function ToolCard({ msg }: { msg: ToolMessage }) {
  // Borderless, inline-on-chat row. For edit/write tools the diff renders
  // inline by default (it's the whole point); expanding reveals raw args or
  // tool output. For everything else, expand toggles args + result.
  //
  // Tool messages restored from a saved transcript don't carry a precomputed
  // `msg.diff` (it's only set on tool_execution_end), so we re-derive on the
  // fly from name + args.
  const isRead = msg.name === 'read' || msg.name === 'view'
  const isWrite = msg.name === 'write'
  const diff = useMemo(
    () => (isWrite ? undefined : msg.diff ?? deriveDiff(msg.name, msg.args, msg.result)),
    [isWrite, msg.diff, msg.name, msg.args, msg.result],
  )
  const isEditish = !!diff
  const [expanded, setExpanded] = useState(false)
  const liveOutput = msg.status === 'running' ? msg.partialText : undefined
  const Icon = toolIcon(msg.name)
  const verb = toolVerb(msg)
  const summary = toolSummary(msg)

  // Pull the relevant pieces for read / write custom views.
  const a = (msg.args ?? {}) as Record<string, unknown>
  const writeContent = isWrite
    ? ((a.content as string) ?? (a.text as string) ?? '')
    : ''
  const readBody = isRead && msg.result ? stripCatN(msg.result) : ''
  const readStartLine =
    isRead && typeof a.offset === 'number' ? (a.offset as number) : 1

  const hasExtras =
    isEditish ||
    (isWrite && writeContent.length > 0) ||
    (isRead && readBody.length > 0) ||
    !!msg.result || !!liveOutput || !!msg.error || msg.args != null

  return (
    <div className="text-[12px]">
      <button
        onClick={() => hasExtras && setExpanded((v) => !v)}
        className={`w-full flex items-center gap-1.5 text-left ${hasExtras ? 'hover:text-primary' : 'cursor-default'}`}
      >
        {hasExtras
          ? expanded
            ? <CaretDown size={9} className="text-muted shrink-0" />
            : <CaretRight size={9} className="text-muted shrink-0" />
          : <span className="w-[9px] shrink-0" />}
        <Icon size={11} className="text-muted shrink-0" />
        <span className="text-muted shrink-0">{verb}</span>
        <span className="truncate text-primary/90 font-mono flex-1">{summary}</span>
        <StatusIcon status={msg.status} />
      </button>
      {expanded && hasExtras && (
        <div className="mt-1 pl-5 space-y-1.5">
          {isEditish && diff && <DiffView diff={diff} />}
          {isWrite && writeContent && (
            <CodePreview text={writeContent} />
          )}
          {isRead && readBody && (
            <CodePreview text={readBody} startLine={readStartLine} />
          )}
          {!isEditish && !isWrite && !isRead && (
            <pre className="text-[11px] text-muted whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[180px] overflow-auto">
              {prettyArgs(msg.args)}
            </pre>
          )}
          {liveOutput && (
            <pre className="text-[11px] text-primary/80 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[240px] overflow-auto">
              {liveOutput}
              <span className="inline-block w-[2px] h-[1em] align-middle bg-primary/80 ml-0.5 animate-pulse" />
            </pre>
          )}
          {!isRead && msg.result && (
            <pre className="text-[11px] text-primary/80 whitespace-pre-wrap break-words font-mono leading-relaxed max-h-[240px] overflow-auto">
              {msg.result}
            </pre>
          )}
          {msg.error && (
            <pre className="text-[11px] text-rose-300/90 whitespace-pre-wrap break-words font-mono leading-relaxed">
              {msg.error}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function formatTokensShort(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// -----------------------------------------------------------------------------
// Subagent card — rich UI for the `subagent` tool: per-subagent rows with
// status, agent name, task, usage stats, and an expandable inner activity
// stream (streaming text + nested tool calls).
// -----------------------------------------------------------------------------

function SubagentCard({ msg }: { msg: ToolMessage }) {
  const [expanded, setExpanded] = useState(true)
  const args = (msg.args ?? {}) as Record<string, unknown>
  const fallbackResults: SubagentResult[] = useMemo(() => {
    if (msg.subagent) return msg.subagent.results
    const stubs: SubagentResult[] = []
    const push = (agent: unknown, task: unknown) => {
      if (typeof agent === 'string' && typeof task === 'string') {
        stubs.push({ agent, task, exitCode: -1, parts: [] })
      }
    }
    if (Array.isArray(args.chain)) {
      for (const step of args.chain as unknown[]) {
        if (step && typeof step === 'object') {
          const s = step as Record<string, unknown>
          push(s.agent, s.task)
        }
      }
    } else if (Array.isArray(args.tasks)) {
      for (const t of args.tasks as unknown[]) {
        if (t && typeof t === 'object') {
          const s = t as Record<string, unknown>
          push(s.agent, s.task)
        }
      }
    } else {
      push(args.agent, args.task)
    }
    return stubs
  }, [msg.subagent, args])
  const results = msg.subagent?.results ?? fallbackResults

  const running = msg.status === 'running' || msg.status === 'pending'
  const total = results.length
  const done = results.filter((r) => r.exitCode !== -1).length
  const succeeded = results.filter((r) => r.exitCode === 0).length
  const failed = results.filter((r) => r.exitCode > 0).length
  const inFlight = total - done

  const headerStatus = (() => {
    if (msg.status === 'error') {
      return failed > 0 ? `${failed} failed` : 'error'
    }
    if (msg.status === 'success') {
      return failed > 0 ? `${succeeded} ok · ${failed} failed` : `${succeeded || total} done`
    }
    if (total === 0) return 'starting…'
    return `${done}/${total} done${inFlight > 0 ? ` · ${inFlight} running` : ''}`
  })()

  return (
    <div className="rounded-lg border border-agent/20 bg-agent/[0.04] overflow-hidden text-[12px]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-agent/[0.08] text-left"
      >
        {expanded
          ? <CaretDown size={10} className="text-muted shrink-0" />
          : <CaretRight size={10} className="text-muted shrink-0" />}
        <Sparkle size={13} weight="duotone" className="text-agent-light shrink-0" />
        <span className="text-primary/90 font-medium shrink-0">Subagent</span>
        <span className="flex-1 text-muted text-[11px] truncate text-right">{headerStatus}</span>
        {running
          ? <Spinner size={11} className="text-agent-light animate-spin shrink-0" />
          : msg.status === 'error'
          ? <XCircle size={12} weight="fill" className="text-rose-400 shrink-0" />
          : <CheckCircle size={12} weight="fill" className="text-agent-light shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-agent/15 px-2 py-2 space-y-1.5">
          {results.length === 0 ? (
            <div className="text-[11px] text-muted italic px-1 py-1">Waiting for subagent to start…</div>
          ) : (
            results.map((r, i) => <SubagentResultRow key={i} result={r} parentRunning={running} />)
          )}
          {msg.error && (
            <pre className="mt-1 text-[11px] text-rose-300 whitespace-pre-wrap break-words font-mono leading-relaxed bg-rose-500/10 rounded p-2">
              {msg.error}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function SubagentResultRow({
  result,
  parentRunning,
}: {
  result: SubagentResult
  parentRunning: boolean
}) {
  const isRunning = result.exitCode === -1 && parentRunning
  const isError = result.exitCode > 0
  const [expanded, setExpanded] = useState(isRunning)
  // Auto-open while running, auto-close on completion (only if user hasn't toggled).
  const userToggled = useRef(false)
  useEffect(() => {
    if (!userToggled.current) setExpanded(isRunning)
  }, [isRunning])

  const toggle = () => {
    userToggled.current = true
    setExpanded((v) => !v)
  }

  const usageBits: string[] = []
  if (result.usage?.turns) usageBits.push(`${result.usage.turns} turn${result.usage.turns > 1 ? 's' : ''}`)
  if (result.usage?.input) usageBits.push(`↑${formatTokensShort(result.usage.input)}`)
  if (result.usage?.output) usageBits.push(`↓${formatTokensShort(result.usage.output)}`)
  if (result.usage?.cost) usageBits.push(`$${result.usage.cost.toFixed(3)}`)

  return (
    <div className="rounded-md bg-black/20 border border-white/[0.04] overflow-hidden">
      <button
        onClick={toggle}
        className="w-full flex items-start gap-2 px-2 py-1.5 hover:bg-white/[0.03] text-left"
      >
        <div className="shrink-0 mt-[2px]">
          {isRunning
            ? <Spinner size={11} className="text-agent-light animate-spin" />
            : isError
            ? <XCircle size={11} weight="fill" className="text-rose-400" />
            : result.exitCode === 0
            ? <CheckCircle size={11} weight="fill" className="text-agent-light" />
            : <Spinner size={11} className="text-muted" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-[11.5px] text-agent-light shrink-0">{result.agent}</span>
            {result.step != null && (
              <span className="text-[10px] text-muted shrink-0">#{result.step}</span>
            )}
            {result.agentSource === 'project' && (
              <span className="text-[9px] uppercase tracking-wider px-1 rounded bg-amber-500/15 text-amber-300">
                project
              </span>
            )}
            <span className="text-[11.5px] text-primary/85 truncate flex-1">{result.task}</span>
            {expanded
              ? <CaretDown size={9} className="text-muted shrink-0" />
              : <CaretRight size={9} className="text-muted shrink-0" />}
          </div>
          {usageBits.length > 0 && (
            <div className="mt-0.5 text-[10.5px] text-muted font-mono">
              {usageBits.join(' · ')}{result.model ? ` · ${result.model}` : ''}
            </div>
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-white/5 px-2.5 py-1.5 space-y-1">
          {result.parts.length === 0 && !result.errorMessage && !result.stderr && (
            <div className="text-[11px] text-muted italic">
              {isRunning ? 'Working…' : '(no output)'}
            </div>
          )}
          {result.parts.map((p, i) => {
            if (p.type === 'text' && p.text) {
              return (
                <div key={i} className="text-[12px] text-primary/90 leading-relaxed">
                  <Markdown text={p.text} />
                </div>
              )
            }
            if (p.type === 'toolCall' && p.toolCall) {
              return <SubagentToolCallRow key={i} call={p.toolCall} />
            }
            return null
          })}
          {result.errorMessage && (
            <pre className="text-[11px] text-rose-300 whitespace-pre-wrap break-words font-mono leading-relaxed bg-rose-500/10 rounded p-2">
              {result.errorMessage}
            </pre>
          )}
          {result.stderr && (
            <pre className="text-[11px] text-muted whitespace-pre-wrap break-words font-mono leading-relaxed bg-black/30 rounded p-2 max-h-[160px] overflow-auto">
              {result.stderr}
            </pre>
          )}
          {!isRunning && result.exitCode === 0 && result.parts.length === 0 && result.finalText && (
            <div className="text-[12px] text-primary/90 leading-relaxed">
              <Markdown text={result.finalText} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SubagentToolCallRow({ call }: { call: SubagentToolCall }) {
  const Icon = toolIcon(call.name)
  const args = call.args ?? {}
  const summary = (() => {
    if (call.name === 'bash' || call.name === 'shell') {
      const cmd = (args.command as string) ?? (args.cmd as string) ?? ''
      return cmd
    }
    if (['edit', 'write', 'str_replace', 'str_replace_based_edit_tool'].includes(call.name)) {
      return (args.path as string) ?? (args.file_path as string) ?? ''
    }
    if (call.name === 'read' || call.name === 'view') {
      return (args.path as string) ?? (args.file_path as string) ?? ''
    }
    if (call.name === 'grep' || call.name === 'search') {
      return (args.pattern as string) ?? (args.query as string) ?? ''
    }
    return ''
  })()
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted font-mono">
      <Icon size={10} className="shrink-0 text-muted/70" />
      <span className="shrink-0">{call.name}</span>
      {summary && (
        <span className="truncate text-primary/70">{summary}</span>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Plan Ready card — rendered for `plan_complete` tool calls emitted by the
// cate-plan-mode pi extension. Shows summary + ordered steps + three actions:
// Implement, Refine plan, Clear context & implement. Locks after any action
// so historical cards can't re-trigger.
// -----------------------------------------------------------------------------

interface PlanStep {
  title: string
  detail?: string
}

interface PlanArgs {
  summary?: string
  steps?: PlanStep[]
}

function parsePlanArgs(raw: unknown): PlanArgs {
  let obj: unknown = raw
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { /* fall through */ }
  }
  if (!obj || typeof obj !== 'object') return {}
  const o = obj as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary : undefined
  const steps: PlanStep[] = []
  if (Array.isArray(o.steps)) {
    for (const s of o.steps) {
      if (s && typeof s === 'object') {
        const r = s as Record<string, unknown>
        const title = typeof r.title === 'string' ? r.title : undefined
        const detail = typeof r.detail === 'string' ? r.detail : undefined
        if (title) steps.push({ title, detail })
      }
    }
  }
  return { summary, steps }
}

function PlanReadyCard({
  msg,
  onImplement,
  onRefine,
  onClearAndImplement,
  stale,
}: {
  msg: ToolMessage
  onImplement?: () => void
  onRefine?: (text: string) => void
  onClearAndImplement?: () => void
  /** True when this plan is no longer the latest message in the thread — i.e.
   *  the user already acted on it (or moved on) in a prior session that has
   *  since been reloaded. Card renders read-only. */
  stale?: boolean
}) {
  const { summary, steps } = useMemo(() => parsePlanArgs(msg.args), [msg.args])
  const [refineText, setRefineText] = useState('')
  const [locked, setLocked] = useState<null | 'implement' | 'refine' | 'clear'>(null)
  const effectiveLocked = locked ?? (stale ? 'implement' : null)

  const handleImplement = () => {
    if (effectiveLocked) return
    setLocked('implement')
    onImplement?.()
  }
  const handleRefine = () => {
    if (effectiveLocked) return
    const text = refineText.trim()
    if (!text) return
    setLocked('refine')
    onRefine?.(text)
  }
  const handleClear = () => {
    if (effectiveLocked) return
    setLocked('clear')
    onClearAndImplement?.()
  }

  const lockLabel = (base: string, kind: 'implement' | 'refine' | 'clear'): string => {
    // Only re-label when this session triggered the action — a stale reload
    // shows the original labels (we don't know which action was taken).
    if (!locked) return base
    if (locked === kind) {
      if (kind === 'implement') return 'Implemented'
      if (kind === 'refine') return 'Refined'
      return 'Cleared and implemented'
    }
    return base
  }

  return (
    <div className={`rounded-lg border border-agent/40 bg-agent/10 overflow-hidden text-[12px] ${effectiveLocked ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-agent/20">
        <ClipboardText size={13} weight="duotone" className="text-agent-light shrink-0" />
        <span className="text-primary font-medium">Plan ready</span>
      </div>
      <div className="px-3 py-3 space-y-3">
        {summary && (
          <div className="text-[12.5px] text-primary/90 leading-relaxed whitespace-pre-wrap break-words">
            {summary}
          </div>
        )}
        {steps && steps.length > 0 && (
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="shrink-0 text-agent-light font-mono text-[12px] mt-[1px]">
                  {i + 1}.
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-primary font-medium leading-snug">
                    {s.title}
                  </div>
                  {s.detail && (
                    <div className="text-[11.5px] text-primary/75 leading-relaxed mt-0.5 whitespace-pre-wrap break-words">
                      {s.detail}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        <textarea
          value={refineText}
          onChange={(e) => setRefineText(e.target.value)}
          disabled={!!effectiveLocked}
          rows={2}
          placeholder="Refine: type the changes you want…"
          className="w-full rounded-md bg-black/20 border border-agent/20 focus:border-agent-light/60 outline-none px-2.5 py-2 text-[12px] text-primary placeholder:text-muted resize-none disabled:opacity-50"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleRefine}
            disabled={!!effectiveLocked || refineText.trim().length === 0}
            className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-agent/20 text-primary text-[11.5px] font-medium disabled:opacity-50 disabled:cursor-default disabled:hover:bg-white/5"
          >
            {lockLabel('Refine plan', 'refine')}
          </button>
          <button
            onClick={handleClear}
            disabled={!!effectiveLocked}
            className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-agent/20 text-primary text-[11.5px] font-medium disabled:opacity-50 disabled:cursor-default disabled:hover:bg-white/5"
          >
            {lockLabel('Clear context & implement', 'clear')}
          </button>
          <div className="flex-1" />
          <button
            onClick={handleImplement}
            disabled={!!effectiveLocked}
            className="px-3 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11.5px] font-medium disabled:opacity-50 disabled:cursor-default disabled:hover:bg-agent"
          >
            {lockLabel('Implement', 'implement')}
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: ToolMessage['status'] }) {
  switch (status) {
    case 'pending':
    case 'running':
      return <Spinner size={11} className="text-agent-light animate-spin shrink-0" />
    case 'success':
      return <CheckCircle size={11} weight="fill" className="text-agent-light shrink-0" />
    case 'error':
    case 'denied':
      return <XCircle size={11} weight="fill" className="text-muted shrink-0" />
  }
}

function prettyArgs(args: unknown): string {
  try {
    return typeof args === 'string' ? args : JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

// -----------------------------------------------------------------------------
// Inline diff
// -----------------------------------------------------------------------------

interface DiffLine {
  kind: 'context' | 'add' | 'del'
  text: string
}

function buildDiffLines(diff: DiffInfo): DiffLine[] {
  if (diff.edits && diff.edits.length > 0) {
    const out: DiffLine[] = []
    diff.edits.forEach((e, i) => {
      if (i > 0) out.push({ kind: 'context', text: '' })
      for (const l of e.oldString.split('\n')) out.push({ kind: 'del', text: l })
      for (const l of e.newString.split('\n')) out.push({ kind: 'add', text: l })
    })
    return out
  }
  if (diff.oldString != null || diff.newString != null) {
    const oldLines = (diff.oldString ?? '').split('\n')
    const newLines = (diff.newString ?? '').split('\n')
    const out: DiffLine[] = []
    for (const l of oldLines) out.push({ kind: 'del', text: l })
    for (const l of newLines) out.push({ kind: 'add', text: l })
    return out
  }
  if (diff.before != null && diff.after != null) {
    return lineDiff(diff.before, diff.after)
  }
  if (diff.after != null) {
    return diff.after.split('\n').map((t) => ({ kind: 'add' as const, text: t }))
  }
  return []
}

function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const m = a.length
  const n = b.length
  if (m * n > 250_000) {
    return [
      ...a.map((t) => ({ kind: 'del' as const, text: t })),
      ...b.map((t) => ({ kind: 'add' as const, text: t })),
    ]
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ kind: 'context', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++ }
    else { out.push({ kind: 'add', text: b[j] }); j++ }
  }
  while (i < m) { out.push({ kind: 'del', text: a[i++] }) }
  while (j < n) { out.push({ kind: 'add', text: b[j++] }) }
  return out
}

function DiffView({ diff }: { diff: DiffInfo }) {
  const lines = useMemo(() => buildDiffLines(diff), [diff])
  return (
    <div className="max-h-[280px] overflow-auto font-mono text-[11px] leading-snug">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.kind === 'add'
              ? 'text-agent-light'
              : l.kind === 'del'
              ? 'text-rose-300/80 line-through decoration-rose-400/30'
              : 'text-muted'
          }
        >
          <span className="inline-block w-3 text-center select-none opacity-60">
            {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
          </span>
          <span className="whitespace-pre-wrap break-words">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Approval card
// -----------------------------------------------------------------------------

function ApprovalCard({
  req,
  onDecide,
}: {
  req: { toolCallId: string; toolName: string; args: unknown }
  onDecide: (decision: 'allow' | 'deny') => void
}) {
  return (
    <div className="rounded-lg border border-agent/40 bg-agent/10 px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-[12px] text-primary">
        <Wrench size={12} className="text-agent-light" />
        <span>
          Allow <strong className="font-mono">{req.toolName}</strong>?
        </span>
      </div>
      <pre className="text-[11px] text-primary/80 whitespace-pre-wrap break-words font-mono max-h-[160px] overflow-auto bg-black/20 rounded p-2">
        {prettyArgs(req.args)}
      </pre>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onDecide('allow')}
          className="px-2.5 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium"
        >
          Allow
        </button>
        <button
          onClick={() => onDecide('deny')}
          className="px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary text-[11px] font-medium"
        >
          Deny
        </button>
      </div>
    </div>
  )
}
