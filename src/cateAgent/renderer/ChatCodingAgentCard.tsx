import { useMemo, useState } from 'react'
import { ArrowSquareOut, Robot } from '@phosphor-icons/react'
import type { ToolMessage } from './codingStore'
import { useAppStore } from '../../renderer/stores/appStore'
import { revealPanel } from '../../renderer/lib/workspace/panelReveal'
import { useAgentTerminalStatus, agentStateLabel } from './useAgentTerminalStatus'
import { codingAgentDisplayName, parseCodingAgentId } from '../../shared/codingAgentRuns'
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

  return (
    <div
      className={`rounded-lg border border-strong/70 bg-surface-2/50 p-2.5 text-[12px] cate-fade-in ${
        running || shimmer ? 'cate-notif-pulse' : ''
      }`}
      data-tool-name="create_coding_agent"
    >
      <div className="flex items-center gap-2">
        <Robot size={15} className="shrink-0 text-accent" />
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-primary">{label}</span>
            <span className="shrink-0 text-[10.5px] text-muted">{status}</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-primary/75">{prompt}</div>
        </button>
        {panelId && workspaceId && (
          <button
            aria-label="Open coding agent terminal"
            title="Open coding agent terminal"
            className="rounded p-1 text-muted hover:bg-hover-strong hover:text-primary"
            onClick={() => { void revealPanel(workspaceId, panelId) }}
          >
            <ArrowSquareOut size={14} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 border-t border-strong/50 pt-2">
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
