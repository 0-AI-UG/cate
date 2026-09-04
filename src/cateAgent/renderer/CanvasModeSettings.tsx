import { CompactChoiceList } from '../../renderer/chat/CompactChoiceList'

export type CanvasModeAccess = 'inspect' | 'existing' | 'create'

export interface CanvasModeConfig {
  access: CanvasModeAccess
}

export const DEFAULT_CANVAS_MODE_CONFIG: CanvasModeConfig = { access: 'create' }

/** Commands consumed by the bundled cate-canvas-mode extension. */
export const canvasModeEnableCommand = (config: CanvasModeConfig): string =>
  `/canvas ${config.access}`

export const canvasModeUpdateCommand = (config: CanvasModeConfig): string =>
  `/canvas-config ${config.access}`

export const canvasModeSummary = (config: CanvasModeConfig): string =>
  config.access === 'inspect'
    ? 'Inspect'
    : config.access === 'existing'
      ? 'Existing'
      : 'Create'

const ACCESS_OPTIONS: { value: CanvasModeAccess; label: string; title: string }[] = [
  {
    value: 'inspect',
    label: 'Inspect only',
    title: 'Observe the canvas without controlling or changing panels',
  },
  {
    value: 'existing',
    label: 'Existing panels',
    title: 'Control open panels without creating new ones',
  },
  {
    value: 'create',
    label: 'New panels',
    title: 'Allow Cate to open or create panels when needed',
  },
]

/** Compact content for the composer-anchored Canvas mode popover. */
export function CanvasModeSettings({
  config,
  onChange,
}: {
  config: CanvasModeConfig
  onChange: (config: CanvasModeConfig) => void
}) {
  return (
    <div data-canvas-mode-settings>
      <CompactChoiceList
        label="Canvas access"
        options={ACCESS_OPTIONS}
        value={config.access}
        onChange={(access) => onChange({ access })}
      />
    </div>
  )
}
