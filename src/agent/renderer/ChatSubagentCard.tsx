// =============================================================================
// ChatSubagentCard — rich UI for the `subagent` tool: per-subagent rows with
// status, agent name, task, usage stats, and an expandable inner activity
// stream (streaming text + nested tool calls).
// =============================================================================

import { useMemo, useState } from 'react'
import { Info } from '@phosphor-icons/react'
import type {
  SubagentResult,
  SubagentToolCall,
  ToolMessage,
} from './agentStore'
import { Markdown } from './ChatMarkdown'
import { formatTokensShort, toolIcon } from './chatShared'

export function SubagentCard({ msg, shimmer }: { msg: ToolMessage; shimmer?: boolean }) {
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

  return (
    <div className="text-[12px] cate-fade-in">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-1.5 text-left hover:text-primary ${running || shimmer ? 'cate-notif-pulse' : ''}`}
      >
        <span className="text-muted shrink-0">subagent</span>
        <span className="truncate text-primary/90 font-mono flex-1">
          {results.length > 0 ? `${results.length} task${results.length > 1 ? 's' : ''}` : ''}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 pl-4 space-y-1.5">
          {results.length === 0 ? (
            <div className="text-[11px] text-muted italic font-mono leading-snug">Waiting for subagent to start…</div>
          ) : (
            results.map((r, i) => <SubagentResultRow key={i} result={r} parentRunning={running} />)
          )}
          {msg.error && (
            <pre className="text-[11px] text-danger whitespace-pre-wrap break-words font-mono leading-snug">
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
  const terminalStop = result.stopReason === 'stop' || result.stopReason === 'error' ||
    result.stopReason === 'length' || result.stopReason === 'aborted'
  const isRunning = parentRunning && !terminalStop
  const [expanded, setExpanded] = useState(false)

  const toggle = () => setExpanded((v) => !v)

  const usageBits: string[] = []
  if (result.usage?.turns) usageBits.push(`${result.usage.turns} turn${result.usage.turns > 1 ? 's' : ''}`)
  if (result.usage?.input) usageBits.push(`↑${formatTokensShort(result.usage.input)}`)
  if (result.usage?.output) usageBits.push(`↓${formatTokensShort(result.usage.output)}`)
  if (result.usage?.cost) usageBits.push(`$${result.usage.cost.toFixed(3)}`)

  const summary = result.task
  const hasExtras = result.parts.length > 0 || !!result.errorMessage || !!result.stderr || !!result.finalText

  return (
    <div className="text-[12px]">
      <button
        onClick={toggle}
        className={`w-full flex items-center gap-1.5 text-left ${hasExtras ? 'hover:text-primary' : 'cursor-default'}`}
      >
        <span className={`font-mono text-[11px] shrink-0 ${isRunning ? 'cate-notif-pulse' : 'text-muted'}`}>{result.agent}</span>
        {result.step != null && (
          <span className={`text-[10px] shrink-0 ${isRunning ? 'cate-notif-pulse' : 'text-muted'}`}>#{result.step}</span>
        )}
        <span className="truncate text-primary font-mono flex-1">{summary}</span>
        {usageBits.length > 0 && (
          <span
            className="relative shrink-0 group/info"
            onClick={(e) => e.stopPropagation()}
          >
            <Info size={11} className="text-muted hover:text-primary/70 cursor-help" />
            <span className="absolute bottom-full right-0 mb-1 hidden group-hover/info:block whitespace-nowrap text-[10px] text-primary/90 font-mono bg-surface-2 border border-strong rounded px-1.5 py-1 shadow-lg z-10">
              {usageBits.join(' · ')}{result.model ? ` · ${result.model}` : ''}
            </span>
          </span>
        )}
      </button>
      {expanded && hasExtras && (
        <div className="mt-1 pl-4 space-y-1 select-text cursor-text">
          {result.parts.length === 0 && !result.errorMessage && !result.stderr && (
            <div className="text-[11px] text-muted italic font-mono leading-snug">
              {isRunning ? 'Working…' : '(no output)'}
            </div>
          )}
          {result.parts.map((p, i) => {
            if (p.type === 'text' && p.text) {
              return (
                <div key={i} className="text-[12px] text-primary/90 leading-snug">
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
            <pre className="text-[11px] text-danger whitespace-pre-wrap break-words font-mono leading-snug">
              {result.errorMessage}
            </pre>
          )}
          {result.stderr && (
            <pre className="text-[11px] text-muted whitespace-pre-wrap break-words font-mono leading-snug max-h-[280px] overflow-auto">
              {result.stderr}
            </pre>
          )}
          {!isRunning && result.exitCode === 0 && result.parts.length === 0 && result.finalText && (
            <div className="text-[12px] text-primary/90 leading-snug">
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
