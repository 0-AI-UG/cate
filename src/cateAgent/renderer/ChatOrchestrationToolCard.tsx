import { useMemo, useState } from 'react'
import type { ToolMessage } from './codingStore'
import { prettyArgs } from './chatShared'

export const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_to_coding_agent',
  'wait_for_coding_agents',
  'inspect_coding_agent',
  'stop_coding_agent',
])

function resultObject(result: string | undefined): Record<string, unknown> {
  if (!result) return {}
  try {
    const parsed = JSON.parse(result)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function compact(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function runLabel(args: Record<string, unknown>, result: Record<string, unknown>): string {
  if (typeof result.agentName === 'string') return result.agentName
  const runId = typeof args.runId === 'string' ? args.runId : ''
  return runId ? `agent ${runId.slice(0, 8)}` : 'coding agent'
}

export function orchestrationToolSummary(msg: ToolMessage): { verb: string; detail: string } {
  const args = (msg.args ?? {}) as Record<string, unknown>
  const result = resultObject(msg.result)
  const running = msg.status === 'running' || msg.status === 'pending'
  const failed = msg.status === 'error' || msg.status === 'denied'

  switch (msg.name) {
    case 'send_to_coding_agent':
      return {
        verb: failed ? 'Steering failed' : running ? 'Steering' : 'Steered',
        detail: `${runLabel(args, result)} · ${compact(String(args.prompt ?? 'follow-up prompt'))}`,
      }
    case 'inspect_coding_agent':
      return {
        verb: failed ? 'Inspection failed' : running ? 'Inspecting' : 'Inspected',
        detail: `${runLabel(args, result)}${
          typeof result.status === 'string' ? ` · ${result.status}` : ''
        }`,
      }
    case 'stop_coding_agent':
      return {
        verb: failed ? 'Stop failed' : running ? 'Stopping' : 'Stopped',
        detail: runLabel(args, result),
      }
    case 'wait_for_coding_agents': {
      const runs = Array.isArray(result.runs) ? result.runs as Array<Record<string, unknown>> : []
      const requested = Array.isArray(args.runIds) ? args.runIds.length : undefined
      const count = runs.length || requested
      const subject = count ? `${count} coding agent${count === 1 ? '' : 's'}` : 'coding agents'
      if (failed) return { verb: 'Monitoring failed', detail: subject }
      if (running) return { verb: 'Monitoring', detail: `${subject} for meaningful changes` }
      if (result.timedOut === true) {
        return {
          verb: 'Monitored',
          detail: `${subject} · no change after ${Number(args.timeoutSeconds ?? 60)}s`,
        }
      }
      const changedIds = Array.isArray(result.changedRunIds)
        ? result.changedRunIds.filter((id): id is string => typeof id === 'string')
        : []
      const changedRuns = runs.filter((run) => changedIds.includes(String(run.id)))
      if (changedRuns.length === 1) {
        const changedRun = changedRuns[0]
        const agent = typeof changedRun.agentName === 'string' ? changedRun.agentName : 'Coding agent'
        const status = typeof changedRun.status === 'string' ? changedRun.status : 'updated'
        return { verb: 'Agent update', detail: `${agent} · ${status}` }
      }
      return {
        verb: 'Agent update',
        detail: changedIds.length ? `${changedIds.length} of ${subject} changed state` : subject,
      }
    }
    default:
      return { verb: 'Used', detail: msg.name }
  }
}

export function OrchestrationToolCard({
  msg,
  shimmer,
}: {
  msg: ToolMessage
  shimmer?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const summary = useMemo(() => orchestrationToolSummary(msg), [msg])
  const liveOutput = msg.status === 'running' ? msg.partialText : undefined
  const output = liveOutput ?? msg.result
  const running = msg.status === 'running' || msg.status === 'pending'
  const hasDetails = msg.args != null || !!output || !!msg.error

  return (
    <div className="text-[12px] cate-fade-in" data-tool-name={msg.name}>
      <button
        onClick={() => hasDetails && setExpanded((value) => !value)}
        className={`flex w-full items-center gap-1.5 text-left ${
          running || shimmer ? 'cate-notif-pulse' : ''
        } ${hasDetails ? 'hover:text-primary' : 'cursor-default'}`}
      >
        <span className="shrink-0 text-muted">{summary.verb}</span>
        <span className="flex-1 truncate text-primary/90">{summary.detail}</span>
      </button>
      {expanded && hasDetails && (
        <div className="mt-1 space-y-2 pl-4 select-text cursor-text">
          {msg.args != null && (
            <div>
              <div className="mb-0.5 text-[9.5px] font-medium uppercase tracking-wide text-muted/70">
                Input
              </div>
              <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-primary/75">
                {prettyArgs(msg.args)}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="mb-0.5 text-[9.5px] font-medium uppercase tracking-wide text-muted/70">
                Output
              </div>
              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-primary/80">
                {output}
              </pre>
            </div>
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
