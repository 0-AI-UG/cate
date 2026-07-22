import { Check } from '@phosphor-icons/react'
import { CLI_PERMISSIONS, type CliPermissionCell } from '../../shared/cliPermissions'
import { useSettingsStore } from '../stores/settingsStore'
import { SearchableBlock, SettingRow, Toggle } from './SettingsComponents'

// -----------------------------------------------------------------------------
// Permission matrix — surface (row) × access level (column), rendered straight
// from CLI_PERMISSIONS so the UI and the main-process gate can't drift. Read
// observes, Control acts; a surface with no cell for a column (Notifications
// can only act) renders an empty slot rather than a dead checkbox.
// -----------------------------------------------------------------------------

interface CheckboxProps {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  disabled?: boolean
}

function PermissionCheckbox({ checked, onChange, title, disabled }: CheckboxProps) {
  return (
    <button
      onClick={() => onChange(!checked)}
      disabled={disabled}
      title={title}
      className={`w-5 h-5 rounded flex items-center justify-center border transition-colors disabled:opacity-40 disabled:cursor-default ${
        checked
          ? 'bg-focus-blue border-focus-blue text-white'
          : 'bg-surface-5 border-subtle hover:border-focus-blue'
      }`}
    >
      {checked && <Check size={12} weight="bold" />}
    </button>
  )
}

export function CliSettings() {
  const store = useSettingsStore()
  const off = !store.cliEnabled

  const cell = (c: CliPermissionCell | undefined) =>
    c ? (
      <PermissionCheckbox
        checked={store[c.key]}
        onChange={(v) => store.setSetting(c.key, v)}
        title={c.detail}
        disabled={off}
      />
    ) : (
      <span className="text-muted text-xs">—</span>
    )

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Command-line control (cate CLI)"
        description="Lets agents and tools running in your terminals drive Cate through the `cate` command. Off: no endpoint is created and nothing below applies. New terminals pick up a change."
      >
        <Toggle
          checked={store.cliEnabled}
          onChange={(v) => store.setSetting('cliEnabled', v)}
        />
      </SettingRow>

      <SearchableBlock keywords="cli permissions browser terminal panels editor notifications read control screenshot snapshot click type keystrokes create focus close notify">
        <div className={`py-3 border-b border-subtle ${off ? 'opacity-50' : ''}`}>
          <div className="mb-2">
            <span className="text-sm text-primary">Permissions</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="text-left font-normal py-1" />
                <th className="font-normal py-1 w-24">Read</th>
                <th className="font-normal py-1 w-24">Control</th>
              </tr>
            </thead>
            <tbody>
              {CLI_PERMISSIONS.map((surface) => (
                <tr key={surface.label}>
                  <td className="text-primary py-1.5">{surface.label}</td>
                  <td className="py-1.5">
                    <div className="flex justify-center">{cell(surface.read)}</div>
                  </td>
                  <td className="py-1.5">
                    <div className="flex justify-center">{cell(surface.control)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SearchableBlock>

      <SettingRow
        label="Install cate CLI skill"
        description="Auto-install the cate-cli skill into each workspace so agents learn the `cate` command. Installs once, never overwrites edits; uninstalls stick."
      >
        <Toggle
          checked={store.cliSkillInstallEnabled}
          onChange={(v) => store.setSetting('cliSkillInstallEnabled', v)}
        />
      </SettingRow>
    </div>
  )
}
