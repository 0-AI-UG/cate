// =============================================================================
// UsageSidebarView — Token usage tracker sidebar panel.
// Shows global totals, per-model breakdowns, and per-project rows.
// =============================================================================

import React, { useMemo } from 'react'
import { ArrowsClockwise, Sparkle, Robot, Code } from '@phosphor-icons/react'
import { useUsageStore } from '../stores/usageStore'
import { useAppStore } from '../stores/appStore'
import { SidebarSectionHeader, SidebarHeaderButton } from './SidebarSectionHeader'
import type { ModelUsage, AgentTool, TokenCounts } from '../../shared/types'

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(cost: number | null): string {
  if (cost === null) return '—'
  if (cost < 0.01 && cost > 0) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

function totalTokenCount(t: TokenCounts): number {
  return t.input + t.output + t.cacheCreate + t.cacheRead
}

// -----------------------------------------------------------------------------
// Tool grouping
// -----------------------------------------------------------------------------

const TOOL_LABELS: Record<AgentTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

const TOOL_ICONS: Record<AgentTool, typeof Sparkle> = {
  claude: Sparkle,
  codex: Robot,
  opencode: Code,
}

const TOOL_ORDER: AgentTool[] = ['claude', 'codex', 'opencode']

// -----------------------------------------------------------------------------
// Date helpers
// -----------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function last7DaysSet(): Set<string> {
  const result = new Set<string>()
  const now = new Date()
  for (let i = 0; i < 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    result.add(d.toISOString().slice(0, 10))
  }
  return result
}

function sumDayUsage(
  projects: { byDay: { date: string; tokens: TokenCounts; costUsd: number | null }[] }[],
  dateFilter: (date: string) => boolean,
): { tokens: number; costUsd: number | null } {
  let tokens = 0
  let costUsd: number | null = 0
  for (const project of projects) {
    for (const day of project.byDay) {
      if (!dateFilter(day.date)) continue
      tokens += totalTokenCount(day.tokens)
      if (day.costUsd !== null) costUsd = (costUsd ?? 0) + day.costUsd
      else costUsd = null
    }
  }
  return { tokens, costUsd }
}

function aggregateByTool(
  projects: { byModel: ModelUsage[] }[],
): Record<AgentTool, ModelUsage[]> {
  const map: Record<string, { tokens: TokenCounts; costUsd: number | null; messageCount: number }> = {}
  const toolMap: Record<string, AgentTool> = {}

  for (const project of projects) {
    for (const mu of project.byModel) {
      const key = `${mu.tool}::${mu.model}`
      if (!map[key]) {
        map[key] = { tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, costUsd: 0, messageCount: 0 }
        toolMap[key] = mu.tool
      }
      const entry = map[key]
      entry.tokens.input += mu.tokens.input
      entry.tokens.output += mu.tokens.output
      entry.tokens.cacheCreate += mu.tokens.cacheCreate
      entry.tokens.cacheRead += mu.tokens.cacheRead
      entry.messageCount += mu.messageCount
      if (mu.costUsd !== null && entry.costUsd !== null) entry.costUsd += mu.costUsd
      else entry.costUsd = null
    }
  }

  const result: Record<AgentTool, ModelUsage[]> = { claude: [], codex: [], opencode: [] }
  for (const [key, entry] of Object.entries(map)) {
    const tool = toolMap[key]
    const model = key.replace(`${tool}::`, '')
    result[tool].push({ model, tool, tokens: entry.tokens, costUsd: entry.costUsd, messageCount: entry.messageCount })
  }
  for (const tool of TOOL_ORDER) {
    result[tool].sort((a, b) => totalTokenCount(b.tokens) - totalTokenCount(a.tokens))
  }
  return result
}

function toolTotals(rows: ModelUsage[]): { tokens: number; costUsd: number | null } {
  let tokens = 0
  let costUsd: number | null = 0
  for (const r of rows) {
    tokens += totalTokenCount(r.tokens)
    if (r.costUsd !== null && costUsd !== null) costUsd += r.costUsd
    else costUsd = null
  }
  return { tokens, costUsd }
}

// -----------------------------------------------------------------------------
// Card primitives
// -----------------------------------------------------------------------------

const Card: React.FC<React.PropsWithChildren<{ className?: string; onClick?: () => void; title?: string }>> = ({
  children,
  className = '',
  onClick,
  title,
}) => (
  <div
    className={`rounded-md bg-surface-3 border border-subtle overflow-hidden ${
      onClick ? 'cursor-pointer hover:bg-hover hover:border-strong transition-all' : ''
    } ${className}`}
    onClick={onClick}
    title={title}
  >
    {children}
  </div>
)

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] text-muted uppercase tracking-wider font-medium px-0.5">{children}</div>
)

const StatCard: React.FC<{ label: string; tokens: number; costUsd: number | null }> = ({ label, tokens, costUsd }) => (
  <Card className="flex-1 min-w-0">
    <div className="px-2.5 py-2 flex flex-col gap-0.5">
      <span className="text-[9px] text-muted uppercase tracking-wider leading-none">{label}</span>
      <span className="text-[14px] font-semibold text-primary tabular-nums leading-tight mt-1">
        {formatTokens(tokens)}
      </span>
      <span className="text-[10px] text-secondary tabular-nums leading-none">{formatCost(costUsd)}</span>
    </div>
  </Card>
)

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export const UsageSidebarView: React.FC = () => {
  const summary = useUsageStore((s) => s.summary)
  const loading = useUsageStore((s) => s.loading)
  const loadSummary = useUsageStore((s) => s.loadSummary)

  // Trigger the main-process usage scan the first time this view is shown.
  React.useEffect(() => {
    useUsageStore.getState().ensureLoaded()
  }, [])

  const today = useMemo(() => todayIso(), [])
  const last7 = useMemo(() => last7DaysSet(), [])

  const allProjects = useMemo(() => (summary ? summary.projects : []), [summary])

  const todayStats = useMemo(() => sumDayUsage(allProjects, (d) => d === today), [allProjects, today])
  const week7Stats = useMemo(() => sumDayUsage(allProjects, (d) => last7.has(d)), [allProjects, last7])
  const allTimeTokens = useMemo(() => (summary ? totalTokenCount(summary.totals.tokens) : 0), [summary])

  const byTool = useMemo(() => aggregateByTool(allProjects), [allProjects])

  const sortedProjects = useMemo(
    () => [...allProjects].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)),
    [allProjects],
  )

  const workspaces = useAppStore((s) => s.workspaces)

  const handleProjectClick = (projectPath: string) => {
    const ws = workspaces.find((w) => w.rootPath === projectPath)
    if (!ws) return
    useAppStore.getState().selectWorkspace(ws.id)
  }

  const hasAnyData = summary && allProjects.length > 0

  return (
    <div className="flex flex-col h-full overflow-hidden text-primary">
      <SidebarSectionHeader
        title="Token Usage"
        actions={
          <SidebarHeaderButton onClick={loadSummary} title="Refresh" disabled={loading} spinning={loading}>
            <ArrowsClockwise size={12} />
          </SidebarHeaderButton>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-4">
        {/* Stat cards */}
        {summary && (
          <div className="flex gap-2">
            <StatCard label="Today" tokens={todayStats.tokens} costUsd={todayStats.costUsd} />
            <StatCard label="7 Days" tokens={week7Stats.tokens} costUsd={week7Stats.costUsd} />
            <StatCard label="All Time" tokens={allTimeTokens} costUsd={summary.totals.costUsd} />
          </div>
        )}

        {!hasAnyData && !loading && (
          <Card>
            <div className="px-3 py-6 text-[12px] text-muted text-center">
              No usage data yet.
              <div className="text-[10px] text-muted mt-1">Run an agent in a workspace to start tracking.</div>
            </div>
          </Card>
        )}

        {loading && !summary && (
          <div className="text-[12px] text-muted text-center py-4">Loading…</div>
        )}

        {/* By Model — one card per tool */}
        {hasAnyData && (
          <div className="space-y-2">
            <SectionLabel>By Model</SectionLabel>
            {TOOL_ORDER.map((tool) => {
              const rows = byTool[tool]
              if (!rows || rows.length === 0) return null
              const Icon = TOOL_ICONS[tool]
              const totals = toolTotals(rows)
              return (
                <Card key={tool}>
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-subtle">
                    <div className="w-6 h-6 rounded bg-surface-2 flex items-center justify-center shrink-0 text-secondary">
                      <Icon size={12} />
                    </div>
                    <span className="text-[12px] font-medium text-primary flex-1 truncate">{TOOL_LABELS[tool]}</span>
                    <span className="text-[10px] text-muted tabular-nums">{formatTokens(totals.tokens)}</span>
                    <span className="text-[10px] text-secondary tabular-nums w-12 text-right">
                      {formatCost(totals.costUsd)}
                    </span>
                  </div>
                  <div className="px-1 py-1">
                    {rows.map((mu) => (
                      <div
                        key={mu.model}
                        className="flex items-center gap-2 h-6 px-2 rounded hover:bg-hover"
                      >
                        <span className="text-[11px] text-secondary truncate flex-1 font-mono">{mu.model}</span>
                        <span className="text-[10px] text-muted tabular-nums">
                          {formatTokens(totalTokenCount(mu.tokens))}
                        </span>
                        <span className="text-[10px] text-secondary tabular-nums w-12 text-right">
                          {formatCost(mu.costUsd)}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )
            })}
          </div>
        )}

        {/* By Project — one card per project */}
        {hasAnyData && sortedProjects.length > 0 && (
          <div className="space-y-2">
            <SectionLabel>By Project</SectionLabel>
            <div className="space-y-1.5">
              {sortedProjects.map((proj) => {
                const basename = proj.projectPath.split('/').filter(Boolean).pop() ?? proj.projectPath
                const matchingWs = workspaces.find((w) => w.rootPath === proj.projectPath)
                const isClickable = Boolean(matchingWs)
                const total = totalTokenCount(proj.totals.tokens)
                const dotColor = matchingWs?.color ?? '#ffffff20'

                return (
                  <Card
                    key={proj.projectPath}
                    onClick={isClickable ? () => handleProjectClick(proj.projectPath) : undefined}
                    title={proj.projectPath}
                    className={isClickable ? '' : 'opacity-70'}
                  >
                    <div className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: dotColor }}
                        />
                        <span className="text-[12px] text-primary font-medium truncate flex-1">{basename}</span>
                        <span className="text-[10px] text-muted tabular-nums">{formatTokens(total)}</span>
                        <span className="text-[10px] text-secondary tabular-nums w-12 text-right">
                          {formatCost(proj.totals.costUsd)}
                        </span>
                      </div>
                      <div className="text-[10px] text-muted truncate mt-0.5 pl-3.5 font-mono">
                        {proj.projectPath}
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
