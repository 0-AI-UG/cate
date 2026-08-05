import { CheckCircle } from '@phosphor-icons/react'

export type PlanExploreAgentCount = 0 | 1 | 2 | 3 | 4

export interface PlanModeConfig {
  exploreAgents: PlanExploreAgentCount
}

export const DEFAULT_PLAN_MODE_CONFIG: PlanModeConfig = { exploreAgents: 2 }

/** Commands consumed by the bundled cate-plan-mode extension. */
export const planModeEnableCommand = (config: PlanModeConfig): string =>
  `/plan explorers=${config.exploreAgents}`

export const planModeUpdateCommand = (config: PlanModeConfig): string =>
  `/plan-config explorers=${config.exploreAgents}`

export const planModeSummary = (config: PlanModeConfig): string =>
  config.exploreAgents === 0
    ? 'Main only'
    : `${config.exploreAgents} ${config.exploreAgents === 1 ? 'scout' : 'scouts'}`

const EXPLORE_OPTIONS: { value: PlanExploreAgentCount; label: string }[] = [
  { value: 0, label: 'Main agent only' },
  { value: 1, label: '1 scout' },
  { value: 2, label: '2 scouts' },
  { value: 3, label: '3 scouts' },
  { value: 4, label: '4 scouts' },
]

/** Compact content for the composer-anchored Plan mode popover. */
export function PlanModeSettings({
  config,
  onChange,
}: {
  config: PlanModeConfig
  onChange: (config: PlanModeConfig) => void
}) {
  return (
    <div data-plan-mode-settings className="text-[11px]">
      <div className="mb-1.5 text-[10px] text-muted">Explore agents</div>
      <div className="overflow-hidden rounded-md border border-subtle bg-surface-2 divide-y divide-subtle">
        {EXPLORE_OPTIONS.map((option) => {
          const selected = config.exploreAgents === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange({ exploreAgents: option.value })}
              className={`flex h-6 w-full items-center gap-1.5 px-2 text-left text-[10px] transition-colors ${
                selected ? 'text-primary bg-hover' : 'text-secondary hover:text-primary hover:bg-hover'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected && (
                <CheckCircle size={10} weight="fill" className="shrink-0 text-agent-light" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
