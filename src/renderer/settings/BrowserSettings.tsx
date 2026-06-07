import { useSettingsStore } from '../stores/settingsStore'
import type { BrowserSearchEngine, TerminalLinkOpenTarget } from '../../shared/types'
import { SettingRow, TextInput, Select } from './SettingsComponents'
import { useTranslation } from '../hooks/useTranslation'

export function BrowserSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label={t('browser.homepage')}>
        <TextInput
          value={store.browserHomepage}
          onChange={(v) => store.setSetting('browserHomepage', v)}
          placeholder="about:blank"
        />
      </SettingRow>
      <SettingRow label={t('browser.searchEngine')}>
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
        label={t('browser.linkTarget')}
        description="Where Cmd/Ctrl+click on a terminal link opens. Cmd/Ctrl+Shift+click always uses the system browser."
      >
        <Select
          value={store.terminalLinkOpenTarget}
          onChange={(v) => store.setSetting('terminalLinkOpenTarget', v as TerminalLinkOpenTarget)}
          options={[
            { value: 'ask', label: t('browser.linkTarget.ask') },
            { value: 'canvas', label: t('browser.linkTarget.browser') },
            { value: 'external', label: t('browser.linkTarget.external') },
          ]}
        />
      </SettingRow>
    </div>
  )
}
