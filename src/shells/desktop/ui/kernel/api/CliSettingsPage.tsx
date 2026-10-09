// CLI settings page (kernel/api's slice): the `cate` API master switch, the
// permission matrix (area x read/control, rendered from CLI_PERMISSION_AREAS
// so the page and the runtime's gate cannot drift) and the bundled cate-cli
// skill. Workspace settings: they apply for everyone in the workspace.

import { useState } from 'react'
import { Check } from 'lucide-react'
import { useRuntime } from '../rpc'
import { SearchableBlock, SecondaryButton, SettingRow, Toggle } from '../interaction'
import { errorMessage } from '@kernel/interaction'
import { setWorkspaceSetting, useWorkspaceSettings } from '../settings'
import { cliAreasOf, type CliPermissionArea, type CliPermissionCell } from '@kernel/api/contract'
import type { WorkspaceSettingKey } from '@panels/settings'
import { CATE_API } from '@panels/api'

function PermissionCheckbox({ checked, onChange, title, disabled }: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={title}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      title={title}
      className={`w-5 h-5 rounded flex items-center justify-center border transition-colors disabled:opacity-40 disabled:cursor-default ${
        checked ? 'bg-focus-blue border-focus-blue text-white' : 'bg-surface-5 border-subtle hover:border-focus-blue'
      }`}
    >
      {checked && <Check size={12} />}
    </button>
  )
}

export function CliSettingsPage({ workspaceId }: { workspaceId: string | null }): JSX.Element | null {
  const settings = useWorkspaceSettings(workspaceId)
  const runtime = useRuntime(workspaceId)
  const [reinstalling, setReinstalling] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  if (!workspaceId) return null
  const off = !settings.cliEnabled
  const set = (key: Parameters<typeof setWorkspaceSetting>[1], value: boolean) => {
    void setWorkspaceSetting(workspaceId, key, value as never).catch(() => {})
  }

  const reinstallSkill = async () => {
    if (!runtime || reinstalling) return
    setReinstalling(true)
    setStatus(null)
    try {
      const result = await runtime.skills.reinstallBundled({ name: 'cate-cli' })
      setStatus({ ok: true, message: `Reinstalled for ${result.installedTargets} agent target${result.installedTargets === 1 ? '' : 's'}.` })
    } catch (err) {
      setStatus({ ok: false, message: errorMessage(err, 'Could not reinstall the skill.') })
    } finally {
      setReinstalling(false)
    }
  }

  const cell = (c: CliPermissionCell | undefined, area: string, access: string) =>
    c ? (
      <PermissionCheckbox checked={(settings as Record<string, unknown>)[c.key] === true} onChange={(v) => set(c.key as WorkspaceSettingKey, v as never)} title={`${area} ${access}: ${c.detail}`} disabled={off} />
    ) : (
      <span className="text-muted text-xs">—</span>
    )

  const areas: CliPermissionArea[] = cliAreasOf(CATE_API)

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Command-line control (cate CLI)"
        description="Lets agents and tools running in this workspace's terminals drive Cate through the `cate` command. New terminals pick up a change."
      >
        <Toggle checked={settings.cliEnabled} onChange={(v) => set('cliEnabled', v)} />
      </SettingRow>
      <SearchableBlock keywords="cli permissions browser terminal panels editor notifications agents read control screenshot snapshot click type keystrokes create focus close notify">
        <div className={`py-3 border-b border-subtle ${off ? 'opacity-50' : ''}`}>
          <div className="mb-2"><span className="text-sm text-primary">Permissions</span></div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted">
                <th className="text-left font-normal py-1" />
                <th className="font-normal py-1 w-24">Read</th>
                <th className="font-normal py-1 w-24">Control</th>
              </tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <tr key={area.label}>
                  <td className="text-primary py-1.5">{area.label}</td>
                  <td className="py-1.5"><div className="flex justify-center">{cell(area.read, area.label, 'read')}</div></td>
                  <td className="py-1.5"><div className="flex justify-center">{cell(area.control, area.label, 'control')}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SearchableBlock>
      <SettingRow
        label="Install cate CLI skill"
        description="Install the cate-cli skill into this workspace so agents learn the `cate` command. Installs once, never overwrites edits; uninstalls stick."
        hint={status && <span className={`text-xs ${status.ok ? 'text-success' : 'text-danger'}`}>{status.message}</span>}
      >
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={() => void reinstallSkill()} disabled={!runtime} loading={reinstalling} title="Replace installed copies with the bundled skill">
            {reinstalling ? 'Reinstalling' : 'Reinstall skill'}
          </SecondaryButton>
          <Toggle checked={settings.cliSkillInstallEnabled} onChange={(v) => set('cliSkillInstallEnabled', v)} />
        </div>
      </SettingRow>
    </div>
  )
}
