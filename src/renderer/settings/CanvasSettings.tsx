import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, NumberInput, Slider, Select } from './SettingsComponents'
import type { CanvasGridStyle } from '../../shared/types'

export function CanvasSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Zoom speed" description={`${store.zoomSpeed.toFixed(1)}x`}>
        <Slider value={store.zoomSpeed} onChange={(v) => store.setSetting('zoomSpeed', v)} min={0.5} max={3.0} step={0.1} />
      </SettingRow>
      <SettingRow
        label="Auto-focus largest visible panel"
        description="Automatically activate whichever panel occupies the most visible area as you pan and zoom."
      >
        <Toggle
          checked={store.autoFocusLargestVisibleNode}
          onChange={(v) => store.setSetting('autoFocusLargestVisibleNode', v)}
        />
      </SettingRow>
      <SettingRow
        label="Snap to grid"
        description="Align panels to the canvas grid while dragging and resizing. Hold Alt to bypass it temporarily (except when dragging between windows)."
      >
        <Toggle
          checked={store.snapToGrid}
          onChange={(v) => store.setSetting('snapToGrid', v)}
        />
      </SettingRow>
      <SettingRow
        label="Recommend where new panels go"
        description="On Cmd+T or a toolbar click, zoom out and show numbered spots to choose from (or click anywhere). Turn off to place each new panel in the best spot automatically."
      >
        <Toggle
          checked={store.placementPicker}
          onChange={(v) => store.setSetting('placementPicker', v)}
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
      <SettingRow label="Default panel width">
        <NumberInput value={store.defaultPanelWidth} onChange={(v) => store.setSetting('defaultPanelWidth', v)} min={300} max={1200} step={50} />
      </SettingRow>
      <SettingRow label="Default panel height">
        <NumberInput value={store.defaultPanelHeight} onChange={(v) => store.setSetting('defaultPanelHeight', v)} min={200} max={900} step={50} />
      </SettingRow>
    </div>
  )
}
