// =============================================================================
// ChatMessageRow — renders a single chat message (user / assistant / system /
// tool). Dispatches tool messages to the right card (subagent, plan, generic).
//
// Wrapped in React.memo: ChatThread re-renders on every streaming token, but
// only the streaming assistant row (and any trailing shimmer rows) actually
// change identity — memo lets the rest skip re-rendering.
// =============================================================================

import { memo, useState } from 'react'
import { Copy } from '@phosphor-icons/react'
import { Tooltip } from '../../renderer/ui/Tooltip'
import { useRenderCount } from '../../renderer/lib/perf/perfClient'
import type { AgentMessage } from './agentStore'
import { Markdown, CursorBlink } from './ChatMarkdown'
import { ToolCard, AskUserToolView } from './ChatToolCard'
import { SubagentCard } from './ChatSubagentCard'
import { PlanReadyCard } from './ChatPlanCard'
import { formatTime } from './chatShared'

interface MessageRowProps {
  msg: AgentMessage
  shimmer?: boolean
  forkEntryId?: string
  onFork?: (entryId: string) => void
  onEditResend?: (text: string) => void
  onImplementPlan?: () => void
  onRefinePlan?: (text: string) => void
  onClearAndImplement?: () => void
  isLast?: boolean
  showModelTag?: boolean
  isCurrentTurn?: boolean
  agentRunning?: boolean
}

export const MessageRow = memo(function MessageRow({
  msg,
  shimmer,
  onImplementPlan,
  onRefinePlan,
  onClearAndImplement,
  isLast,
  showModelTag,
  isCurrentTurn,
  agentRunning,
}: MessageRowProps) {
  useRenderCount('MessageRow')
  if (msg.type === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] px-3.5 py-2 rounded-2xl rounded-br-md bg-hover-strong text-primary text-[13px] whitespace-pre-wrap break-words select-text cursor-text">
          {msg.text}
        </div>
        <div className="flex items-center gap-0.5 text-muted">
          <Tooltip label="Copy message">
            <button
              onClick={() => { void navigator.clipboard.writeText(msg.text) }}
              aria-label="Copy message"
              className="p-1 rounded-md hover:text-primary hover:bg-hover-strong"
            >
              <Copy size={11} />
            </button>
          </Tooltip>
          {msg.createdAt && (
            <span className="text-[10.5px] text-muted/70 ml-1">{formatTime(msg.createdAt)}</span>
          )}
        </div>
      </div>
    )
  }
  if (msg.type === 'assistant') {
    return (
      <div className={`text-[13.5px] text-primary leading-relaxed space-y-1.5 cate-fade-in ${shimmer ? 'cate-notif-pulse' : ''}`}>
        {msg.thinking && <ThinkingBlock text={msg.thinking} streaming={msg.streaming && !msg.text} />}
        <div>
          <Markdown text={msg.text} />
          {msg.streaming && !msg.text && msg.thinking ? null : msg.streaming && <CursorBlink />}
        </div>
        {!msg.streaming && showModelTag && msg.stopReason === 'stop' && !(agentRunning && isCurrentTurn) && (
          <div className="flex items-center gap-0.5 text-muted">
            <Tooltip label="Copy message">
              <button
                onClick={() => { void navigator.clipboard.writeText(msg.text) }}
                aria-label="Copy message"
                className="p-1 rounded-md hover:text-primary hover:bg-hover-strong"
              >
                <Copy size={11} />
              </button>
            </Tooltip>
            {(msg.model || msg.createdAt) && (
              <span className="text-[10.5px] text-muted ml-1">
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
        ? 'text-danger'
        : msg.kind === 'warning'
        ? 'text-warning'
        : 'text-muted'
    return <div className={`text-center text-[11px] italic ${tone}`}>{msg.text}</div>
  }
  if (msg.type === 'tool' && msg.name === 'subagent') {
    return <SubagentCard msg={msg} shimmer={shimmer} />
  }
  if (msg.type === 'tool' && msg.name === 'ask_user') {
    return <AskUserToolView msg={msg} shimmer={shimmer} />
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
  return <ToolCard msg={msg} shimmer={shimmer} />
})

function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="text-[12px] cate-fade-in">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 text-left text-muted"
      >
        <span className={streaming ? 'cate-notif-pulse' : ''}>Thinking</span>
      </button>
      {expanded && (
        <pre className="mt-1 pl-4 text-[11px] text-primary/70 whitespace-pre-wrap break-words font-mono leading-snug max-h-[280px] overflow-auto select-text cursor-text">
          {text}
        </pre>
      )}
    </div>
  )
}
