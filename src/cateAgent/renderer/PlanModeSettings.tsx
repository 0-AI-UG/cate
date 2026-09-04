import { CompactChoiceList } from '../../renderer/chat/CompactChoiceList'

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
    <div data-plan-mode-settings>
      <CompactChoiceList
        label="Explore agents"
        options={EXPLORE_OPTIONS}
        value={config.exploreAgents}
        onChange={(exploreAgents) => onChange({ exploreAgents })}
      />
    </div>
  )
}
