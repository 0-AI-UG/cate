import { useMemo, useState } from 'react'
import type { ToolMessage } from './codingStore'
import {
  codingAgentDisplayName,
  parseCodingAgentId,
} from '../../shared/codingAgentRuns'

export const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'send_to_coding_agent',
  'wait_for_coding_agents',
  'inspect_coding_agent',
  'review_coding_agent',
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

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function agentLabel(value: unknown): string {
  const agentId = parseCodingAgentId(value)
  return agentId ? codingAgentDisplayName(agentId) : text(value) || 'Coding agent'
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  if (!value) return null
  return (
    <div className="grid grid-cols-[68px_minmax(0,1fr)] gap-2 text-[11px] leading-snug">
      <span className="text-muted/75">{label}</span>
      <span className={`min-w-0 whitespace-pre-wrap break-words text-primary/80 ${
        mono ? 'font-mono' : ''
      }`}>
        {value}
      </span>
    </div>
  )
}

function RunDetails({ run }: { run: Record<string, unknown> }) {
  const agent = text(run.agentName) || agentLabel(run.agentId)
  return (
    <div className="space-y-1">
      <DetailField label="Agent" value={agent} />
      <DetailField label="State" value={text(run.status)} />
      <DetailField label="Run" value={text(run.id)} mono />
      <DetailField label="Worktree" value={text(run.worktreeId)} mono />
      <DetailField label="Directory" value={text(run.cwd)} mono />
      <DetailField label="Activity" value={text(run.statusLine)} mono />
    </div>
  )
}

function InputDetails({
  name,
  args,
}: {
  name: string
  args: Record<string, unknown>
}) {
  if (name === 'create_coding_agent') {
    return (
      <>
        <DetailField label="Agent" value={agentLabel(args.agentId)} />
        <DetailField label="Role" value={text(args.title)} />
        <DetailField label="Task" value={text(args.prompt)} />
        <DetailField
          label="Worktree"
          value={text(args.newWorktree) || text(args.worktreeId) || 'Current checkout'}
          mono
        />
        <DetailField label="Base ref" value={text(args.baseRef)} mono />
        <DetailField
          label="Monitoring"
          value={args.background === false ? 'Wait explicitly' : 'Wake when ready'}
        />
      </>
    )
  }
  if (name === 'send_to_coding_agent') {
    return (
      <>
        <DetailField label="Run" value={text(args.runId)} mono />
        <DetailField label="Message" value={text(args.prompt)} />
      </>
    )
  }
  if (name === 'wait_for_coding_agents') {
    const runIds = Array.isArray(args.runIds)
      ? args.runIds.filter((id): id is string => typeof id === 'string')
      : []
    return (
      <>
        <DetailField
          label="Targets"
          value={runIds.length > 0 ? runIds.join('\n') : 'All active coding agents'}
          mono={runIds.length > 0}
        />
        <DetailField
          label="Timeout"
          value={`${Number(args.timeoutSeconds ?? 10)} seconds`}
        />
      </>
    )
  }
  return <DetailField label="Run" value={text(args.runId)} mono />
}

function OutputDetails({
  name,
  result,
  rawResult,
}: {
  name: string
  result: Record<string, unknown>
  rawResult?: string
}) {
  if (name === 'review_coding_agent') {
    const review = result.review && typeof result.review === 'object'
      ? result.review as Record<string, unknown>
      : {}
    const files = Array.isArray(review.files)
      ? review.files.filter((file): file is Record<string, unknown> => !!file && typeof file === 'object')
      : []
    const commits = Array.isArray(review.commits) ? review.commits.length : 0
    return (
      <>
        <RunDetails run={result} />
        <DetailField label="Target" value={text(review.baseBranch)} mono />
        <DetailField label="Review" value={`${commits} commit${commits === 1 ? '' : 's'} · ${files.length} changed file${files.length === 1 ? '' : 's'}`} />
        <DetailField label="Apply" value={review.canApply === true ? 'Ready for user approval' : text(review.message)} />
      </>
    )
  }
  if (name === 'wait_for_coding_agents') {
    const runs = Array.isArray(result.runs)
      ? result.runs.filter((run): run is Record<string, unknown> =>
          !!run && typeof run === 'object')
      : []
    const changed = Array.isArray(result.changedRunIds)
      ? result.changedRunIds.filter((id) => typeof id === 'string').length
      : 0
    return (
      <>
        <DetailField
          label="Outcome"
          value={
            result.timedOut === true
              ? 'No meaningful state change before timeout'
              : changed > 0
                ? `${changed} coding agent${changed === 1 ? '' : 's'} need attention`
                : 'No active coding agents'
          }
        />
        <div>
          {runs.map((run, index) => (
            <div
              key={text(run.id) || index}
              className={index > 0 ? 'mt-2 border-t border-strong/40 pt-2' : ''}
            >
              <RunDetails run={run} />
            </div>
          ))}
        </div>
      </>
    )
  }
  if (Object.keys(result).length > 0) {
    return (
      <>
        <RunDetails run={result} />
        {typeof result.recentOutput === 'string' && result.recentOutput && (
          <div>
            <div className="mb-0.5 text-muted/75">Terminal output</div>
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-primary/80">
              {result.recentOutput}
            </pre>
          </div>
        )}
      </>
    )
  }
  return rawResult ? (
    <div className="whitespace-pre-wrap break-words text-[11px] text-primary/80">
      {rawResult}
    </div>
  ) : null
}

export function OrchestrationToolDetails({ msg }: { msg: ToolMessage }) {
  const args = (msg.args ?? {}) as Record<string, unknown>
  const result = resultObject(msg.result)
  const parsed = Object.keys(result).length > 0
  return (
    <div className="space-y-2 select-text cursor-text">
      <div>
        <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wide text-muted/70">
          Input
        </div>
        <div className="space-y-1">
          <InputDetails name={msg.name} args={args} />
        </div>
      </div>
      {(msg.result || msg.error) && (
        <div>
          <div className="mb-1 text-[9.5px] font-medium uppercase tracking-wide text-muted/70">
            Output
          </div>
          <div className="space-y-1.5">
            <OutputDetails
              name={msg.name}
              result={result}
              rawResult={parsed ? undefined : msg.result}
            />
            {msg.error && <div className="text-[11px] text-danger">{msg.error}</div>}
          </div>
        </div>
      )}
    </div>
  )
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
    case 'review_coding_agent': {
      const review = result.review && typeof result.review === 'object'
        ? result.review as Record<string, unknown>
        : {}
      const files = Array.isArray(review.files) ? review.files.length : 0
      return {
        verb: failed ? 'Review failed' : running ? 'Reviewing' : 'Reviewed',
        detail: `${runLabel(args, result)} · ${files} changed file${files === 1 ? '' : 's'}`,
      }
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
  const running = msg.status === 'running' || msg.status === 'pending'
  const hasDetails = msg.args != null || !!msg.result || !!msg.error

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
        <div className="mt-1 pl-4">
          <OrchestrationToolDetails msg={msg} />
        </div>
      )}
    </div>
  )
}
