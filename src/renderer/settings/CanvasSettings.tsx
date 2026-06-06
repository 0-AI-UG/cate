import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, NumberInput, Slider, Select } from './SettingsComponents'
import type { CanvasGridStyle } from '../../shared/types'

export function CanvasSettings() {
  const store = useSettingsStore()

  const bgImagePath = store.canvasBackgroundImagePath
  const bgImageName = bgImagePath ? bgImagePath.split(/[\\/]/).pop() : ''

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
        description={bgImageName || 'Shown behind the canvas, auto-adjusted to keep titles readable.'}
      >
        <div className="flex items-center gap-2">
          {bgImagePath && (
            <button
              onClick={() => store.setSetting('canvasBackgroundImagePath', '')}
              className="px-2.5 py-1 text-sm rounded-md text-muted hover:text-primary transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={chooseBackgroundImage}
            className="px-3 py-1 text-sm rounded-md bg-surface-5 border border-subtle text-primary hover:bg-surface-6 transition-colors"
          >
            {bgImagePath ? 'Change…' : 'Choose…'}
          </button>
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
      <SettingRow label="Default panel width">
        <NumberInput value={store.defaultPanelWidth} onChange={(v) => store.setSetting('defaultPanelWidth', v)} min={300} max={1200} step={50} />
      </SettingRow>
      <SettingRow label="Default panel height">
        <NumberInput value={store.defaultPanelHeight} onChange={(v) => store.setSetting('defaultPanelHeight', v)} min={200} max={900} step={50} />
      </SettingRow>
    </div>
  )
}
