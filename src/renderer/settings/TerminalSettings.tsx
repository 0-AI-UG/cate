import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, TextInput, NumberInput, Toggle, Slider } from './SettingsComponents'
import { useTranslation } from '../hooks/useTranslation'

const IS_MAC = navigator.userAgent.includes('Mac')

export function TerminalSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted mb-3">
        Leave font fields blank for system defaults. Colors follow the active
        theme; change it in Appearance.
      </p>
      <SettingRow label={t('terminal.fontFamily')}>
        <TextInput
          value={store.terminalFontFamily}
          onChange={(v) => store.setSetting('terminalFontFamily', v)}
          placeholder="e.g., Menlo, Monaco"
        />
      </SettingRow>
      <SettingRow label={t('terminal.fontSize')} description="0 = use default">
        <NumberInput
          value={store.terminalFontSize}
          onChange={(v) => store.setSetting('terminalFontSize', v)}
          min={0}
          max={32}
          step={1}
        />
      </SettingRow>
      <SettingRow label={t('terminal.scrollSpeed')} description={`${store.terminalScrollSpeed.toFixed(2)}x`}>
        <Slider
          value={store.terminalScrollSpeed}
          onChange={(v) => store.setSetting('terminalScrollSpeed', v)}
          min={0.25}
          max={3.0}
          step={0.25}
        />
      </SettingRow>
      <SettingRow
        label={t('terminal.contrast')}
        description={
          store.terminalContrast <= 1
            ? 'Off. Theme colors shown exactly.'
            : `${store.terminalContrast.toFixed(1)}:1. Lifts dim text (4.5 = WCAG AA).`
        }
      >
        {/* Slider max is intentionally below clampContrastRatio's 21 ceiling: above
            ~7:1 almost all text is already forced to near-black/near-white, so the
            extra travel does nothing visible. Step 0.1 matches xterm's internal
            rounding. Hand-edited stored values up to 21 still validate. */}
        <Slider
          value={store.terminalContrast}
          onChange={(v) => store.setSetting('terminalContrast', v)}
          min={1}
          max={7}
          step={0.1}
        />
      </SettingRow>
      <SettingRow
        label={t('terminal.cursorBlink')}
        description="A steady cursor avoids a compositor redraw on every blink, saving power when idle."
      >
        <Toggle
          checked={store.terminalCursorBlink}
          onChange={(v) => store.setSetting('terminalCursorBlink', v)}
        />
      </SettingRow>
      {IS_MAC && (
        <SettingRow
          label={t('terminal.optionMeta')}
          description={t('terminal.optionMeta.desc')}
        >
          <Toggle
            checked={store.terminalOptionIsMeta}
            onChange={(v) => store.setSetting('terminalOptionIsMeta', v)}
          />
        </SettingRow>
      )}
      <SettingRow
        label={t('terminal.autoSuspend')}
        description={t('terminal.autoSuspend.desc')}
      >
        <Toggle
          checked={store.autoSuspendIdleTerminals}
          onChange={(v) => store.setSetting('autoSuspendIdleTerminals', v)}
        />
      </SettingRow>
    </div>
  )
}
