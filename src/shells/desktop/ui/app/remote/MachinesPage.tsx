// "Machines" settings page: the SSH machines this device remembers (the
// client setting `sshMachines`), to open a folder on, add or remove.
// Connecting starts in "Open…", which also lists the hosts of the SSH config
// and the WSL distros; a machine is saved there once it answers.

import { useState } from 'react'
import { Server, Trash2 } from 'lucide-react'
import { SearchableBlock, SecondaryButton, SettingRow, TextInput } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { formatSshTarget, parseSshCommand, type SshMachine } from '@runtime/daemon/contract'
import { tryClientApp } from '../app'
import { useUIStore } from '../state/uiStore'
import { forgetMachine } from './machines'

export function MachinesPage(): JSX.Element {
  const setup = tryClientApp()?.machines
  const machines = useClientSetting('sshMachines')
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!setup) {
    return <p className="text-[13px] text-secondary">This version of Cate cannot open workspaces on other machines.</p>
  }

  const add = () => {
    const parsed = parseSshCommand(command)
    if (!parsed.ok) return setError(parsed.error)
    setCommand('')
    setError(null)
    // Saved once it answered.
    useUIStore.getState().openMachineFolder({ kind: 'ssh', target: parsed.target })
  }

  const remove = async (machine: SshMachine) => {
    const ok = await clientUi().confirm(`Remove ${machine.target.destination}? Its workspaces stay in the sidebar.`)
    if (ok) forgetMachine(machine.id)
  }

  return (
    <div className="flex flex-col divide-y divide-subtle">
      <SearchableBlock keywords="ssh remote machines servers saved">
        <div className="py-3 flex flex-col gap-2">
          <span className="text-[13px] font-medium text-primary">SSH machines</span>
          <span className="text-xs text-muted">
            Machines you opened a folder on. Open… (⌘O) also lists the hosts in ~/.ssh/config and the WSL distros of this device.
          </span>
          {machines.length === 0 ? (
            <span className="py-1.5 text-xs text-muted">None yet.</span>
          ) : (
            <ul className="flex flex-col" aria-label="Machines">
              {machines.map((machine) => (
                <li key={machine.id} className="flex items-center gap-3 py-1.5">
                  <Server size={14} className="shrink-0 text-muted" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[13px] text-primary font-mono truncate">{formatSshTarget(machine.target)}</span>
                    {machine.lastPath && <span className="text-xs text-muted font-mono truncate">Last: {machine.lastPath}</span>}
                  </div>
                  <SecondaryButton onClick={() => useUIStore.getState().openMachineFolder({ kind: 'ssh', target: machine.target })}>
                    Open a workspace
                  </SecondaryButton>
                  <button
                    type="button"
                    className="p-1 text-muted hover:text-danger"
                    aria-label={`Remove ${machine.target.destination}`}
                    onClick={() => void remove(machine)}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SearchableBlock>

      <SettingRow
        label="Add a machine"
        description="Its ssh command. Cate signs in with the system ssh (your SSH config, keys and agent, or a password it asks for), installs its runtime there the first time, and opens a folder you pick. A new host is added to known_hosts."
        keywords="ssh remote machine server vps install open folder add command"
        hint={error ? <span role="alert" className="text-xs text-danger">{error}</span> : undefined}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <TextInput
            value={command}
            onChange={setCommand}
            placeholder="ssh user@example.com -p 22"
            layoutClassName="w-64 px-2"
            className="font-mono"
          />
          <SecondaryButton type="submit" disabled={!command.trim()}>
            Add
          </SecondaryButton>
        </form>
      </SettingRow>
    </div>
  )
}
