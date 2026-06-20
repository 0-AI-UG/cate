import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, NumberInput, Slider, Select } from './SettingsComponents'
import type { CanvasGridStyle } from '../../shared/types'
import {
  BUILTIN_WALLPAPERS,
  builtinWallpaperPath,
  getBuiltinWallpaper,
} from '../lib/builtinWallpapers'

export function CanvasSettings() {
  const store = useSettingsStore()

  const bgImagePath = store.canvasBackgroundImagePath
  const activeBuiltin = getBuiltinWallpaper(bgImagePath)
  const isCustomImage = !!bgImagePath && !activeBuiltin
  const customImageName = isCustomImage ? bgImagePath.split(/[\\/]/).pop() : ''

  const chooseBackgroundImage = async () => {
    const picked = await window.electronAPI.openImageDialog()
    if (picked) store.setSetting('canvasBackgroundImagePath', picked)
  }

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Zoom speed" description={`${store.zoomSpeed.toFixed(1)}x`}>
        <Slider value={store.zoomSpeed} onChange={(v) => store.setSetting('zoomSpeed', v)} min={0.5} max={3.0} step={0.1} />
      </SettingRow>
      <SettingRow
        label="Auto-focus largest visible panel"
        description="Activate the panel filling the most visible area as you pan and zoom."
      >
        <Toggle
          checked={store.autoFocusLargestVisibleNode}
          onChange={(v) => store.setSetting('autoFocusLargestVisibleNode', v)}
        />
      </SettingRow>
      <SettingRow
        label="Snap to grid"
        description="Align panels to the grid while dragging and resizing. Hold Alt to bypass."
      >
        <Toggle
          checked={store.snapToGrid}
          onChange={(v) => store.setSetting('snapToGrid', v)}
        />
      </SettingRow>
      <SettingRow
        label="Recommend where new panels go"
        description="On Cmd+T or a toolbar click, show numbered spots to pick from. Off places panels automatically."
      >
        <Toggle
          checked={store.placementPicker}
          onChange={(v) => store.setSetting('placementPicker', v)}
        />
      </SettingRow>
      <SettingRow
        label="Worktree territories"
        description="Paint soft colored backgrounds grouping panels by git worktree (shown when a workspace has multiple worktrees)."
      >
        <Toggle
          checked={store.showWorktreeTerritory}
          onChange={(v) => store.setSetting('showWorktreeTerritory', v)}
        />
      </SettingRow>
      <SettingRow label="Canvas background">
        <Select
          value={store.canvasGridStyle}
          onChange={(v) => store.setSetting('canvasGridStyle', v as CanvasGridStyle)}
          options={[
            { value: 'dots', label: 'Dots' },
            { value: 'lines', label: 'Grid lines' },
            { value: 'none', label: 'None' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Background image"
        description={
          customImageName || 'Shown behind the canvas, auto-adjusted to keep titles readable.'
        }
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <WallpaperSwatch
            selected={!bgImagePath}
            onClick={() => store.setSetting('canvasBackgroundImagePath', '')}
            label="None"
          />
          {BUILTIN_WALLPAPERS.map((wp) => (
            <WallpaperSwatch
              key={wp.id}
              selected={activeBuiltin?.id === wp.id}
              onClick={() => store.setSetting('canvasBackgroundImagePath', builtinWallpaperPath(wp.id))}
              label={wp.name}
              imageUrl={wp.url}
            />
          ))}
          <WallpaperSwatch
            selected={isCustomImage}
            onClick={chooseBackgroundImage}
            label={isCustomImage ? 'Custom' : 'Choose…'}
          />
        </div>
      </SettingRow>
      {bgImagePath && (
        <SettingRow
          label="Background image opacity"
          description={`${Math.round(store.canvasBackgroundImageOpacity * 100)}%`}
        >
          <Slider
            value={store.canvasBackgroundImageOpacity}
            onChange={(v) => store.setSetting('canvasBackgroundImageOpacity', v)}
            min={0.05}
            max={1}
            step={0.05}
          />
        </SettingRow>
      )}
    </div>
  )
}

// A small clickable preview tile for picking a wallpaper. `imageUrl` renders the
// wallpaper itself; without it the tile is a labelled placeholder ("None" /
// "Choose…" / "Custom"). The selected tile gets an accent ring.
function WallpaperSwatch({
  selected,
  onClick,
  label,
  imageUrl,
}: {
  selected: boolean
  onClick: () => void
  label: string
  imageUrl?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-pressed={selected}
      className={`relative h-12 w-20 shrink-0 overflow-hidden rounded-md border text-xs transition-colors ${
        selected
          ? 'border-focus-blue ring-2 ring-focus-blue'
          : 'border-subtle hover:border-strong'
      } ${imageUrl ? '' : 'bg-surface-5 text-muted hover:text-primary'}`}
      style={
        imageUrl
          ? {
              backgroundImage: `url("${imageUrl}")`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : undefined
      }
    >
      {!imageUrl && (
        <span className="flex h-full w-full items-center justify-center px-1 text-center">
          {label}
        </span>
      )}
    </button>
  )
}
