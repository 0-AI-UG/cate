import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, NumberInput, Slider, Select } from './SettingsComponents'
import type { CanvasGridStyle } from '../../shared/types'
import { useTranslation } from '../hooks/useTranslation'

export function CanvasSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()

  const bgImagePath = store.canvasBackgroundImagePath
  const bgImageName = bgImagePath ? bgImagePath.split(/[\\/]/).pop() : ''

  const chooseBackgroundImage = async () => {
    const picked = await window.electronAPI.openImageDialog()
    if (picked) store.setSetting('canvasBackgroundImagePath', picked)
  }

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label={t('canvas.zoomSpeed')} description={`${store.zoomSpeed.toFixed(1)}x`}>
        <Slider value={store.zoomSpeed} onChange={(v) => store.setSetting('zoomSpeed', v)} min={0.5} max={3.0} step={0.1} />
      </SettingRow>
      <SettingRow
        label={t('canvas.autoFocus')}
        description={t('canvas.autoFocus.desc')}
      >
        <Toggle
          checked={store.autoFocusLargestVisibleNode}
          onChange={(v) => store.setSetting('autoFocusLargestVisibleNode', v)}
        />
      </SettingRow>
      <SettingRow
        label={t('canvas.snapToGrid')}
        description={t('canvas.snapToGrid.desc')}
      >
        <Toggle
          checked={store.snapToGrid}
          onChange={(v) => store.setSetting('snapToGrid', v)}
        />
      </SettingRow>
      <SettingRow
        label={t('canvas.placementPicker')}
        description={t('canvas.placementPicker.desc')}
      >
        <Toggle
          checked={store.placementPicker}
          onChange={(v) => store.setSetting('placementPicker', v)}
        />
      </SettingRow>
      <SettingRow label={t('canvas.background')}>
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
        label={t('canvas.backgroundImage')}
        description={bgImageName || 'Shown behind the canvas, auto-adjusted to keep titles readable.'}
      >
        <div className="flex items-center gap-2">
          {bgImagePath && (
            <button
              onClick={() => store.setSetting('canvasBackgroundImagePath', '')}
              className="px-2.5 py-1 text-sm rounded-md text-muted hover:text-primary transition-colors"
            >
              {t('canvas.clear')}
            </button>
          )}
          <button
            onClick={chooseBackgroundImage}
            className="px-3 py-1 text-sm rounded-md bg-surface-5 border border-subtle text-primary hover:bg-surface-6 transition-colors"
          >
            {bgImagePath ? t('canvas.change') : t('canvas.choose')}
          </button>
        </div>
      </SettingRow>
      {bgImagePath && (
        <SettingRow
          label={t('canvas.backgroundOpacity')}
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
      <SettingRow
        label={t('canvas.autoLayoutMode')}
        description={t('canvas.autoLayoutMode.desc')}
      >
        <Select
          value={store.defaultLayoutMode ?? 'grid'}
          onChange={(v) => store.setSetting('defaultLayoutMode', v as 'grid' | 'columns' | 'rows')}
          options={[
            { value: 'grid', label: t('canvas.autoLayoutMode.grid') },
            { value: 'columns', label: t('canvas.autoLayoutMode.columns') },
            { value: 'rows', label: t('canvas.autoLayoutMode.rows') },
          ]}
        />
      </SettingRow>
      <SettingRow label={t('canvas.defaultWidth')}>
        <NumberInput value={store.defaultPanelWidth} onChange={(v) => store.setSetting('defaultPanelWidth', v)} min={300} max={1200} step={50} />
      </SettingRow>
      <SettingRow label={t('canvas.defaultHeight')}>
        <NumberInput value={store.defaultPanelHeight} onChange={(v) => store.setSetting('defaultPanelHeight', v)} min={200} max={900} step={50} />
      </SettingRow>
    </div>
  )
}
