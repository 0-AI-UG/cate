// =============================================================================
// ChatToolCard — collapsed-by-default card for a single tool call. Shows a
// one-line verb + summary; expands to reveal bash output, file diffs, read
// bodies, or generic args/result. Subagent and plan_complete tools have their
// own dedicated cards (see ChatSubagentCard / ChatPlanCard).
// =============================================================================

import { useMemo, useState } from 'react'
import type { ToolMessage } from './agentStore'
import { deriveDiff } from './agentStore'
import { EDIT_NAMES, prettyArgs } from './chatShared'
import { DiffView } from './ChatDiffView'

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
    <div className="font-mono text-[11px] leading-snug max-h-[280px] overflow-auto select-text cursor-text">
      {shown.map((l, i) => (
        <div key={i} className="flex">
          <span className="text-muted/40 select-none w-5 text-right pr-1.5 shrink-0">{startLine + i}</span>
          <span className="whitespace-pre-wrap break-words text-primary/85 flex-1">{l || ' '}</span>
        </div>
      ))}
      {truncated && (
        <div className="text-muted text-[10.5px] mt-1 pl-5">
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

export function ToolCard({ msg, shimmer }: { msg: ToolMessage; shimmer?: boolean }) {
  const isBash = msg.name === 'bash' || msg.name === 'shell'
  const isRead = msg.name === 'read' || msg.name === 'view'
  const isWrite = msg.name === 'write'
  const diff = useMemo(
    () => (isWrite ? undefined : msg.diff ?? deriveDiff(msg.name, msg.args, msg.result)),
    [isWrite, msg.diff, msg.name, msg.args, msg.result],
  )
  const isEditish = !!diff
  const [expanded, setExpanded] = useState(false)
  const liveOutput = msg.status === 'running' ? msg.partialText : undefined
  const verb = toolVerb(msg)
  const summary = toolSummary(msg)

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

  const isRunning = msg.status === 'running' || msg.status === 'pending'

  if (isBash) {
    const cmd = (a.command as string) ?? (a.cmd as string) ?? ''
    const output = liveOutput ?? msg.result ?? ''
    const hasOutput = !!output || !!msg.error
    return (
      <div className="text-[12px] cate-fade-in">
        <button
          onClick={() => hasOutput && setExpanded((v) => !v)}
          className={`w-full flex items-center gap-1.5 text-left ${isRunning || shimmer ? 'cate-notif-pulse' : ''} ${hasOutput ? 'hover:text-primary' : 'cursor-default'}`}
        >
          <span className="text-muted shrink-0">{verb}</span>
          <span className="truncate text-primary/90 font-mono flex-1">{cmd}</span>
        </button>
        {expanded && hasOutput && (
          <div className="mt-1 pl-4 max-h-[280px] overflow-auto font-mono text-[11px] leading-snug select-text cursor-text">
            <pre className="text-primary/80 whitespace-pre-wrap break-words">
              {output}
              {isRunning && <span className="inline-block w-[2px] h-[1em] align-middle bg-primary/80 ml-0.5 animate-pulse" />}
            </pre>
            {msg.error && (
              <pre className="text-danger whitespace-pre-wrap break-words">
                {msg.error}
              </pre>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="text-[12px] cate-fade-in">
      <button
        onClick={() => hasExtras && setExpanded((v) => !v)}
        className={`w-full flex items-center gap-1.5 text-left ${isRunning || shimmer ? 'cate-notif-pulse' : ''} ${hasExtras ? 'hover:text-primary' : 'cursor-default'}`}
      >
        <span className="text-muted shrink-0">{verb}</span>
        <span className="truncate text-primary/90 font-mono flex-1">{summary}</span>
      </button>
      {expanded && hasExtras && (
        <div className="mt-1 pl-4 space-y-1.5 select-text cursor-text">
          {isEditish && diff && <DiffView diff={diff} />}
          {isWrite && writeContent && (
            <CodePreview text={writeContent} />
          )}
          {isRead && readBody && (
            <CodePreview text={readBody} startLine={readStartLine} />
          )}
          {!isEditish && !isWrite && !isRead && (
            <pre className="text-[11px] text-muted whitespace-pre-wrap break-words font-mono leading-snug max-h-[280px] overflow-auto">
              {prettyArgs(msg.args)}
            </pre>
          )}
          {liveOutput && (
            <pre className="text-[11px] text-primary/80 whitespace-pre-wrap break-words font-mono leading-snug max-h-[280px] overflow-auto">
              {liveOutput}
              <span className="inline-block w-[2px] h-[1em] align-middle bg-primary/80 ml-0.5 animate-pulse" />
            </pre>
          )}
          {!isRead && !isEditish && msg.result && (
            <pre className="text-[11px] text-primary/80 whitespace-pre-wrap break-words font-mono leading-snug max-h-[280px] overflow-auto">
              {msg.result}
            </pre>
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
