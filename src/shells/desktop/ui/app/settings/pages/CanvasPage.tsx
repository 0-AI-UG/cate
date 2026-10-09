// Canvas page (ui/client/layout's canvas slice, plus the workspace's
// `panelRelationsEnabled` from workspace/relations while a workspace is
// active). Built-in wallpapers come from the module that bundles them.

import { SettingRow, Select, Slider, Toggle } from '../../../kernel/interaction'
import { setClientSetting, setWorkspaceSetting, useClientSetting, useWorkspaceSetting } from '../../../kernel/settings'
import type { ClientSettings } from '../../../../settings'
import { useDesktopPort } from '../../desktop'
import type { SettingsPageProps } from '../registry'

export const BUILTIN_WALLPAPER_PREFIX = 'builtin:'

export interface BuiltinWallpaper {
  /** Stored as `builtin:<id>` in `canvasBackgroundImagePath`. */
  id: string
  name: string
  /** Preview URL. */
  url: string
}

let wallpapers: readonly BuiltinWallpaper[] = []

/** ui/client/layout/canvas installs the wallpapers it bundles. */
export function installBuiltinWallpapers(list: readonly BuiltinWallpaper[]): void {
  wallpapers = list
}

export function CanvasPage({ workspaceId }: SettingsPageProps): JSX.Element {
  const desktop = useDesktopPort()
  const zoomSpeed = useClientSetting('zoomSpeed')
  const autoFocus = useClientSetting('autoFocusLargestVisibleNode')
  const snapToGrid = useClientSetting('snapToGrid')
  const placementPicker = useClientSetting('placementPicker')
  const territory = useClientSetting('showWorktreeTerritory')
  const gridStyle = useClientSetting('canvasGridStyle')
  const bgImagePath = useClientSetting('canvasBackgroundImagePath')
  const bgOpacity = useClientSetting('canvasBackgroundImageOpacity')
  const relationsEnabled = useWorkspaceSetting(workspaceId, 'panelRelationsEnabled')

  const activeBuiltin = bgImagePath.startsWith(BUILTIN_WALLPAPER_PREFIX)
    ? wallpapers.find((w) => `${BUILTIN_WALLPAPER_PREFIX}${w.id}` === bgImagePath)
    : undefined
  const isCustomImage = !!bgImagePath && !bgImagePath.startsWith(BUILTIN_WALLPAPER_PREFIX)
  const customImageName = isCustomImage ? bgImagePath.split(/[\\/]/).pop() : ''

  const chooseBackgroundImage = async () => {
    const picked = await desktop?.pickImage()
    if (picked) setClientSetting('canvasBackgroundImagePath', picked)
  }

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Zoom speed" description={`${zoomSpeed.toFixed(1)}x`}>
        <Slider value={zoomSpeed} onChange={(v) => setClientSetting('zoomSpeed', v)} min={0.5} max={3.0} step={0.1} />
      </SettingRow>
      <SettingRow label="Auto-focus largest visible panel" description="Activate the panel filling the most visible area as you pan and zoom.">
        <Toggle checked={autoFocus} onChange={(v) => setClientSetting('autoFocusLargestVisibleNode', v)} />
      </SettingRow>
      <SettingRow label="Snap to grid" description="Align panels to the grid while dragging and resizing. Hold Alt to bypass.">
        <Toggle checked={snapToGrid} onChange={(v) => setClientSetting('snapToGrid', v)} />
      </SettingRow>
      <SettingRow
        label="Recommend where new panels go"
        description="On Cmd+T or a toolbar click, show numbered spots to pick from. Off places panels automatically."
      >
        <Toggle checked={placementPicker} onChange={(v) => setClientSetting('placementPicker', v)} />
      </SettingRow>
      <SettingRow
        label="Worktree territories"
        description="Paint soft colored backgrounds grouping panels by git worktree (shown when a workspace has multiple worktrees)."
      >
        <Toggle checked={territory} onChange={(v) => setClientSetting('showWorktreeTerritory', v)} />
      </SettingRow>
      {workspaceId && (
        <SettingRow
          label="Panel relations"
          description="Connect panels and include their context in agent prompts. Applies for everyone in this workspace; existing relations are kept while off."
        >
          <Toggle
            checked={relationsEnabled}
            onChange={(v) => { void setWorkspaceSetting(workspaceId, 'panelRelationsEnabled', v).catch(() => {}) }}
          />
        </SettingRow>
      )}
      <SettingRow label="Grid style">
        <Select
          value={gridStyle}
          onChange={(v) => setClientSetting('canvasGridStyle', v as ClientSettings['canvasGridStyle'])}
          options={[
            { value: 'dots', label: 'Dots' },
            { value: 'lines', label: 'Grid lines' },
            { value: 'none', label: 'None' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Background image"
        description={customImageName || 'Shown behind the canvas, auto-adjusted to keep titles readable.'}
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <WallpaperSwatch selected={!bgImagePath} onClick={() => setClientSetting('canvasBackgroundImagePath', '')} label="None" />
          {wallpapers.map((wp) => (
            <WallpaperSwatch
              key={wp.id}
              selected={activeBuiltin?.id === wp.id}
              onClick={() => setClientSetting('canvasBackgroundImagePath', `${BUILTIN_WALLPAPER_PREFIX}${wp.id}`)}
              label={wp.name}
              imageUrl={wp.url}
            />
          ))}
          {desktop && (
            <WallpaperSwatch selected={isCustomImage} onClick={() => void chooseBackgroundImage()} label={isCustomImage ? 'Custom' : 'Choose…'} />
          )}
        </div>
      </SettingRow>
      {bgImagePath && (
        <SettingRow label="Background image opacity" description={`${Math.round(bgOpacity * 100)}%`}>
          <Slider value={bgOpacity} onChange={(v) => setClientSetting('canvasBackgroundImageOpacity', v)} min={0.05} max={1} step={0.05} />
        </SettingRow>
      )}
    </div>
  )
}

function WallpaperSwatch({ selected, onClick, label, imageUrl }: {
  selected: boolean
  onClick: () => void
  label: string
  imageUrl?: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-pressed={selected}
      className={`relative h-12 w-20 shrink-0 overflow-hidden rounded-md border text-xs transition-colors ${
        selected ? 'border-focus-blue ring-2 ring-focus-blue' : 'border-subtle hover:border-strong'
      } ${imageUrl ? '' : 'bg-surface-5 text-muted hover:text-primary'}`}
      style={imageUrl ? { backgroundImage: `url("${imageUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
    >
      {!imageUrl && <span className="flex h-full w-full items-center justify-center px-1 text-center">{label}</span>}
    </button>
  )
}
