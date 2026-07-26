import { useMemo, useState } from 'react'
import type { ToolMessage } from './codingStore'
import { useAppStore } from '../../renderer/stores/appStore'
import { revealPanel } from '../../renderer/lib/workspace/panelReveal'
import { useAgentTerminalStatus, agentStateLabel } from './useAgentTerminalStatus'
import { codingAgentDisplayName, parseCodingAgentId } from '../../shared/codingAgentRuns'
import { getAgentLogoById } from '../../renderer/lib/agent/agentLogos'
import { CateLogo } from '../../renderer/ui/CateLogo'
import { OrchestrationToolDetails } from './ChatOrchestrationToolCard'

function resultObject(result: string | undefined): Record<string, unknown> {
  if (!result) return {}
  try {
    const parsed = JSON.parse(result)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Native card for a worker created by Cate Agent. The terminal remains a real,
 * visible canvas panel; this is its live mission-level summary and jump target. */
export function CodingAgentCard({ msg, shimmer }: { msg: ToolMessage; shimmer?: boolean }) {
  const result = useMemo(() => resultObject(msg.result), [msg.result])
  const args = (msg.args ?? {}) as Record<string, unknown>
  const panelId = typeof result.panelId === 'string' ? result.panelId : ''
  const agentId = parseCodingAgentId(result.agentId ?? args.agentId)
  const agentLogo = getAgentLogoById(agentId)
  const prompt = typeof args.prompt === 'string' ? args.prompt : 'Coding task'
  const workspaceId = useAppStore((state) =>
    state.workspaces.find((ws) => panelId && ws.panels[panelId])?.id ?? '',
  )
  const terminalStatus = useAgentTerminalStatus(workspaceId, panelId)
  const [expanded, setExpanded] = useState(false)
  const running = msg.status === 'running' || msg.status === 'pending'
  const label = agentId ? codingAgentDisplayName(agentId) : 'Coding agent'
  const status = panelId
    ? agentStateLabel(terminalStatus.agentState)
    : running ? 'Starting…' : msg.error ? 'Failed' : 'Created'
  const canOpenTerminal = Boolean(panelId && workspaceId)
  const statusColor = msg.error
    ? 'bg-danger'
    : terminalStatus.agentState === 'waitingForInput'
      ? 'bg-warning'
      : terminalStatus.agentState === 'finished'
        ? 'bg-[#34C759]'
        : terminalStatus.agentState === 'running'
          ? 'bg-accent'
          : 'bg-muted'

  return (
    <div
      className="text-[12px] cate-fade-in"
      data-tool-name="create_coding_agent"
    >
      <div className="flex min-w-0 items-center gap-2">
        <CateLogo
          size={15}
          aria-label="Cate"
          className="shrink-0 text-[rgb(var(--agent-rgb))]"
        />
        <button
          data-coding-agent-terminal-link
          aria-label={`Open ${label} terminal`}
          title={canOpenTerminal ? `Open terminal · ${status}` : status}
          disabled={!canOpenTerminal}
          className={`inline-flex h-6 max-w-[150px] shrink-0 items-center gap-1.5 rounded-[10px] bg-surface-2 px-2 text-[11px] text-primary transition-colors ${
            canOpenTerminal ? 'hover:bg-hover-strong' : 'cursor-default'
          }`}
          onClick={() => { void revealPanel(workspaceId, panelId) }}
        >
          {agentLogo && (
            <img
              src={agentLogo}
              alt=""
              width={11}
              height={11}
              draggable={false}
              className="shrink-0"
            />
          )}
          <span className={
            running || shimmer || terminalStatus.agentState === 'running'
              ? 'cate-notif-pulse'
              : ''
          }>
            {label}
          </span>
          <span
            aria-label={status}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor}`}
          />
        </button>
        <button
          aria-label="Show coding agent details"
          aria-expanded={expanded}
          className="min-w-0 flex-1 truncate text-left text-[11px] text-primary/75 hover:text-primary"
          onClick={() => setExpanded((value) => !value)}
        >
          {prompt}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 pl-[23px]">
          <OrchestrationToolDetails msg={msg} />
          {terminalStatus.line && (
            <div className="truncate font-mono text-[10.5px] text-muted">
              {terminalStatus.line}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
