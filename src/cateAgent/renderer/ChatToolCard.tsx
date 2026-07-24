import { useMemo, useState } from 'react'
import type { ToolMessage } from './codingStore'
import { deriveDiff } from './codingStore'
import { EDIT_NAMES, prettyArgs } from './chatShared'
import { DiffView } from './ChatDiffView'

function toolSummary(msg: ToolMessage): string {
  const args = (msg.args ?? {}) as Record<string, unknown>
  const name = msg.name.toLowerCase()
  if (EDIT_NAMES.has(msg.name) || EDIT_NAMES.has(name)) {
    return (args.path as string) ?? (args.file_path as string) ?? (args.file as string) ?? msg.name
  }
  if (name === 'bash' || name === 'shell' || name === 'run_terminal_command') {
    return (args.command as string) ?? (args.cmd as string) ?? msg.name
  }
  if (name === 'read' || name === 'view') {
    const path = (args.path as string) ?? (args.file_path as string) ?? ''
    const offset = typeof args.offset === 'number' ? args.offset : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    if (path && offset != null && limit != null) return `${path}:${offset}-${offset + limit}`
    if (path && offset != null) return `${path}:${offset}`
    return path || msg.name
  }
  if (name === 'grep' || name === 'search') {
    return (args.pattern as string) ?? (args.query as string) ?? msg.name
  }
  return msg.name
}

function stripCatN(text: string): string {
  return text
    .split('\n')
    .map((line) => line.match(/^\s*\d+\t(.*)$/)?.[1] ?? line)
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
  const shown = lines.slice(0, maxLines)
  return (
    <div className="max-h-[280px] overflow-auto font-mono text-[11px] leading-snug select-text cursor-text">
      {shown.map((line, index) => (
        <div key={index} className="flex">
          <span className="w-5 shrink-0 select-none pr-1.5 text-right text-muted/40">
            {startLine + index}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-words text-primary/85">
            {line || ' '}
          </span>
        </div>
      ))}
      {lines.length > maxLines && (
        <div className="mt-1 pl-5 text-[10.5px] text-muted">
          … {lines.length - maxLines} more lines
        </div>
      )}
    </div>
  )
}

export function AskUserToolView({
  msg,
  shimmer,
}: {
  msg: ToolMessage
  shimmer?: boolean
}) {
  const args = (msg.args ?? {}) as {
    questions?: Array<{ question: string }>
    question?: string
  }
  const questions = args.questions ?? (args.question ? [{ question: args.question }] : [])
  const [expanded, setExpanded] = useState(false)
  const running = msg.status === 'running' || msg.status === 'pending'
  const hasDetails = questions.length > 0 || !!msg.result || !!msg.error

  return (
    <div className="text-[12px] cate-fade-in">
      <button
        onClick={() => hasDetails && setExpanded((value) => !value)}
        className={`flex w-full items-center gap-1.5 text-left ${
          running || shimmer ? 'cate-notif-pulse' : ''
        } ${hasDetails ? 'hover:text-primary' : 'cursor-default'}`}
      >
        <span className="shrink-0 text-muted">Asked</span>
        <span className="flex-1 truncate text-primary/90">
          {questions[0]?.question ?? 'the user'}
        </span>
      </button>
      {expanded && hasDetails && (
        <div className="mt-1 space-y-1.5 pl-4 text-[11px] select-text cursor-text">
          {msg.result ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-primary/80">
              {msg.result.replace(/^The user answered:\n?/, '')}
            </pre>
          ) : questions.map((question, index) => (
            <div key={index} className="whitespace-pre-wrap break-words text-primary/85">
              {question.question}
            </div>
          ))}
          {msg.error && (
            <pre className="whitespace-pre-wrap break-words text-danger">{msg.error}</pre>
          )}
        </div>
      )}
    </div>
  )
}

function toolVerb(msg: ToolMessage): string {
  const name = msg.name.toLowerCase()
  if (name === 'write') return 'Wrote'
  if (EDIT_NAMES.has(msg.name) || EDIT_NAMES.has(name)) return 'Edited'
  if (name === 'bash' || name === 'shell' || name === 'run_terminal_command') return 'Ran'
  if (name === 'read' || name === 'view') return 'Read'
  if (name === 'grep' || name === 'search') return 'Searched'
  return 'Used'
}

export function ToolCard({ msg, shimmer }: { msg: ToolMessage; shimmer?: boolean }) {
  const name = msg.name.toLowerCase()
  const isBash = name === 'bash' || name === 'shell' || name === 'run_terminal_command'
  const isRead = name === 'read' || name === 'view'
  const isWrite = name === 'write'
  const diff = useMemo(
    () => (isWrite ? undefined : msg.diff ?? deriveDiff(msg.name, msg.args, msg.result)),
    [isWrite, msg.args, msg.diff, msg.name, msg.result],
  )
  const [expanded, setExpanded] = useState(false)
  const liveOutput = msg.status === 'running' ? msg.partialText : undefined
  const running = msg.status === 'running' || msg.status === 'pending'
  const args = (msg.args ?? {}) as Record<string, unknown>
  const writeContent = isWrite
    ? ((args.content as string) ?? (args.text as string) ?? '')
    : ''
  const readBody = isRead && msg.result ? stripCatN(msg.result) : ''
  const hasDetails =
    !!diff ||
    !!writeContent ||
    !!readBody ||
    !!msg.result ||
    !!liveOutput ||
    !!msg.error ||
    msg.args != null

  if (isBash) {
    const output = liveOutput ?? msg.result ?? ''
    const hasOutput = !!output || !!msg.error
    return (
      <div className="text-[12px] cate-fade-in" data-tool-name={name}>
        <button
          onClick={() => hasOutput && setExpanded((value) => !value)}
          className={`flex w-full items-center gap-1.5 text-left ${
            running || shimmer ? 'cate-notif-pulse' : ''
          } ${hasOutput ? 'hover:text-primary' : 'cursor-default'}`}
        >
          <span className="shrink-0 text-muted">Ran</span>
          <span className="flex-1 truncate font-mono text-primary/90">{toolSummary(msg)}</span>
        </button>
        {expanded && hasOutput && (
          <div className="mt-1 max-h-[280px] overflow-auto pl-4 font-mono text-[11px] leading-snug select-text cursor-text">
            <pre className="whitespace-pre-wrap break-words text-primary/80">{output}</pre>
            {msg.error && <pre className="whitespace-pre-wrap break-words text-danger">{msg.error}</pre>}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="text-[12px] cate-fade-in" data-tool-name={name}>
      <button
        onClick={() => hasDetails && setExpanded((value) => !value)}
        className={`flex w-full items-center gap-1.5 text-left ${
          running || shimmer ? 'cate-notif-pulse' : ''
        } ${hasDetails ? 'hover:text-primary' : 'cursor-default'}`}
      >
        <span className="shrink-0 text-muted">{toolVerb(msg)}</span>
        <span className="flex-1 truncate font-mono text-primary/90">{toolSummary(msg)}</span>
      </button>
      {expanded && hasDetails && (
        <div className="mt-1 space-y-1.5 pl-4 select-text cursor-text">
          {diff && <DiffView diff={diff} />}
          {isWrite && writeContent && <CodePreview text={writeContent} />}
          {isRead && readBody && (
            <CodePreview
              text={readBody}
              startLine={typeof args.offset === 'number' ? args.offset : 1}
            />
          )}
          {!diff && !isWrite && !isRead && (
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted">
              {prettyArgs(msg.args)}
            </pre>
          )}
          {liveOutput && (
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-primary/80">
              {liveOutput}
            </pre>
          )}
          {!isRead && !diff && msg.result && (
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-primary/80">
              {msg.result}
            </pre>
          )}
          {msg.error && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-danger">
              {msg.error}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
