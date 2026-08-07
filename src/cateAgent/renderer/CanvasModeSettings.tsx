import { CheckCircle } from '@phosphor-icons/react'

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
    <div data-canvas-mode-settings className="text-[11px]">
      <div className="mb-1.5 text-[10px] text-muted">Canvas access</div>
      <div className="overflow-hidden rounded-md border border-subtle bg-surface-2 divide-y divide-subtle">
        {ACCESS_OPTIONS.map((option) => {
          const selected = config.access === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              title={option.title}
              onClick={() => onChange({ access: option.value })}
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
