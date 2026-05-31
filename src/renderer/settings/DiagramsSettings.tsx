import { useSettingsStore } from '../stores/settingsStore'
import type { PlantumlRender } from '../../shared/types'
import { SettingRow, TextInput, Select } from './SettingsComponents'

export function DiagramsSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="PlantUML rendering"
        description="Mermaid always renders offline. PlantUML is off by default — Server mode sends diagram text to a third-party server, so it's opt-in. Use Local (plantuml.jar) to keep everything on-machine."
      >
        <Select
          value={store.plantumlRender}
          onChange={(v) => store.setSetting('plantumlRender', v as PlantumlRender)}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'server', label: 'Server (sends diagram text)' },
            { value: 'local', label: 'Local (java + jar)' },
          ]}
        />
      </SettingRow>
      {store.plantumlRender === 'server' && (
        <SettingRow
          label="PlantUML server URL"
          description="Diagram text is sent to this server. Point it at a local server (e.g. http://localhost:8080) to keep it private."
        >
          <TextInput
            value={store.plantumlServerUrl}
            onChange={(v) => store.setSetting('plantumlServerUrl', v)}
            placeholder="https://www.plantuml.com/plantuml"
          />
        </SettingRow>
      )}
      {store.plantumlRender === 'local' && (
        <SettingRow
          label="plantuml.jar path"
          description="Absolute path to plantuml.jar. Requires Java on your PATH."
        >
          <TextInput
            value={store.plantumlJarPath}
            onChange={(v) => store.setSetting('plantumlJarPath', v)}
            placeholder="/opt/homebrew/.../plantuml.jar"
          />
        </SettingRow>
      )}
    </div>
  )
}
