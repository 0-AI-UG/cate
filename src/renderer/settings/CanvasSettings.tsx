import { useSettingsStore } from '../stores/settingsStore'
import type { CanvasGridStyle } from '../../shared/types'
import { SettingRow, Toggle, Select, NumberInput, Slider } from './SettingsComponents'

export function CanvasSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Grid style">
        <Select
          value={store.gridStyle}
          onChange={(v) => store.setSetting('gridStyle', v as CanvasGridStyle)}
          options={[
            { value: 'blank', label: 'None' },
            { value: 'dots', label: 'Dots' },
            { value: 'lines', label: 'Lines' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Grid spacing">
        <Select
          value={String(store.gridSpacing)}
          onChange={(v) => store.setSetting('gridSpacing', Number(v))}
          options={[
            { value: '10', label: 'Small (10px)' },
            { value: '20', label: 'Medium (20px)' },
            { value: '40', label: 'Large (40px)' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Snap to grid">
        <Toggle checked={store.snapToGridEnabled} onChange={(v) => store.setSetting('snapToGridEnabled', v)} />
      </SettingRow>
      <SettingRow label="Zoom speed" description={`${store.zoomSpeed.toFixed(1)}x`}>
        <Slider value={store.zoomSpeed} onChange={(v) => store.setSetting('zoomSpeed', v)} min={0.5} max={3.0} step={0.1} />
      </SettingRow>
      <SettingRow label="Show minimap">
        <Toggle checked={store.showMinimap} onChange={(v) => store.setSetting('showMinimap', v)} />
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
