import { useSettingsStore } from '../stores/settingsStore'
import type { BrowserSearchEngine } from '../../shared/types'
import { SettingRow, TextInput, Select, Toggle } from './SettingsComponents'

export function BrowserSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Homepage">
        <TextInput
          value={store.browserHomepage}
          onChange={(v) => store.setSetting('browserHomepage', v)}
          placeholder="about:blank"
        />
      </SettingRow>
      <SettingRow label="Search engine">
        <Select
          value={store.browserSearchEngine}
          onChange={(v) => store.setSetting('browserSearchEngine', v as BrowserSearchEngine)}
          options={[
            { value: 'google', label: 'Google' },
            { value: 'duckDuckGo', label: 'DuckDuckGo' },
            { value: 'bing', label: 'Bing' },
            { value: 'brave', label: 'Brave' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Auto-open URLs from terminal"
        description="When a localhost or http(s) URL appears in terminal output, open it in an existing browser panel (or create one if none exists). Each URL is opened only once."
      >
        <Toggle
          checked={store.autoOpenUrlsFromTerminal}
          onChange={(v) => store.setSetting('autoOpenUrlsFromTerminal', v)}
        />
      </SettingRow>
    </div>
  )
}
