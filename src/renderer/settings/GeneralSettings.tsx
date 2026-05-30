import { InfoIcon, WarningIcon } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, TextInput } from './SettingsComponents'

const NATIVE_TABS_BOOT = new URLSearchParams(window.location.search).get('nativeTabsBoot') === '1'

export function GeneralSettings() {
  const store = useSettingsStore()
  const nativeTabsPending = store.nativeTabs !== NATIVE_TABS_BOOT

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Default shell path" description="Leave blank to auto-detect ($SHELL, then a platform default).">
        <TextInput value={store.defaultShellPath} onChange={(v) => store.setSetting('defaultShellPath', v)} placeholder="Auto-detect" />
      </SettingRow>
      <SettingRow label="Warn before quit" description="Show confirmation dialog on Cmd+Q">
        <Toggle checked={store.warnBeforeQuit} onChange={(v) => store.setSetting('warnBeforeQuit', v)} />
      </SettingRow>
      {navigator.userAgent.includes('Mac') && (
        <SettingRow
          label="Native macOS window tabs"
          description="Group main windows as native tabs in the title bar."
          hint={(NATIVE_TABS_BOOT || nativeTabsPending) ? (
            <>
              {NATIVE_TABS_BOOT && (
                <p className="flex items-center gap-1 text-xs text-muted">
                  <InfoIcon size={12} />
                  Title bar matches your theme's dark/light, but macOS can't tint it the exact theme color while tabs are enabled.
                </p>
              )}
              {nativeTabsPending && (
                <p className="flex items-center gap-1 text-xs text-amber-500 mt-1">
                  <WarningIcon size={12} />
                  Restart required for this change to take effect.
                </p>
              )}
            </>
          ) : undefined}
        >
          <Toggle checked={store.nativeTabs} onChange={(v) => store.setSetting('nativeTabs', v)} />
        </SettingRow>
      )}
      <SettingRow
        label="Send crash reports"
        description="Anonymously report unhandled errors to help us fix bugs."
      >
        <Toggle checked={store.crashReportingEnabled} onChange={(v) => store.setSetting('crashReportingEnabled', v)} />
      </SettingRow>
      <SettingRow
        label="Send anonymous usage data"
        description="App version, OS, and update events — no file paths, project names, or personal data. Helps us see which versions are in use and prompt for feedback after upgrades."
      >
        <Toggle checked={store.usageAnalyticsEnabled} onChange={(v) => store.setSetting('usageAnalyticsEnabled', v)} />
      </SettingRow>
    </div>
  )
}
