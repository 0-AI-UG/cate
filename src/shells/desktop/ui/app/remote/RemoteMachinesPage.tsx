// "Remote machines" settings page: machines this device reaches over SSH
// (saved in the client setting `sshMachines`). Adding one, or "Serve a
// folder" on one, opens the dialog that sets the runtime up there and serves
// a folder as a workspace.

import { useState } from 'react'
import { Server, Trash2 } from 'lucide-react'
import { SearchableBlock, SecondaryButton, TextInput } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { setClientSetting, useClientSetting } from '../../kernel/settings'
import { formatSshTarget, parseSshCommand, type SshMachine } from '@runtime/daemon/contract'
import { tryClientApp } from '../app'
import { ServeOverSshDialog } from './ServeOverSshDialog'
import { withMachine } from './serve'

export function RemoteMachinesPage(): JSX.Element {
  const ssh = tryClientApp()?.ssh
  const machines = useClientSetting('sshMachines')
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [serving, setServing] = useState<SshMachine | null>(null)

  if (!ssh) {
    return <p className="text-[13px] text-secondary">This version of Cate cannot set up other machines.</p>
  }

  const add = () => {
    const parsed = parseSshCommand(command)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    const same = machines.find((m) => formatSshTarget(m.target) === formatSshTarget(parsed.target))
    const machine = same ?? { id: crypto.randomUUID(), target: parsed.target }
    if (!same) setClientSetting('sshMachines', withMachine(machines, machine))
    setCommand('')
    setError(null)
    setServing(machine)
  }

  const remove = async (machine: SshMachine) => {
    const ok = await clientUi().confirm(
      `Remove ${machine.target.destination}? Workspaces already served there stay in the sidebar.`,
    )
    if (ok) setClientSetting('sshMachines', machines.filter((m) => m.id !== machine.id))
  }

  return (
    <div className="flex flex-col gap-1">
      <SearchableBlock keywords="ssh remote machine server vps install serve folder">
        <div className="py-3 border-b border-subtle flex flex-col gap-2">
          <span className="text-[13px] font-medium text-primary">Add machine</span>
          <span className="text-xs text-muted">
            Cate signs in with the system ssh, using your SSH config, keys and agent, installs its runtime there the
            first time, and serves a folder you pick as a workspace. A host seen for the first time is added to
            known_hosts.
          </span>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <TextInput value={command} onChange={setCommand} placeholder="ssh user@example.com -p 22" />
            <SecondaryButton type="submit" disabled={!command.trim()}>
              <Server size={12} />
              Add
            </SecondaryButton>
          </form>
          {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        </div>
      </SearchableBlock>

      <SearchableBlock keywords="ssh remote machines servers">
        <div className="py-3 flex flex-col gap-2">
          <span className="text-[13px] font-medium text-primary">Machines</span>
          {machines.length === 0 ? (
            <span className="text-xs text-muted">No machines yet.</span>
          ) : (
            <ul className="flex flex-col" aria-label="Machines">
              {machines.map((machine) => (
                <li key={machine.id} className="flex items-center gap-3 py-1.5">
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[13px] text-primary font-mono truncate">{formatSshTarget(machine.target)}</span>
                    {machine.lastPath && <span className="text-xs text-muted font-mono truncate">Last: {machine.lastPath}</span>}
                  </div>
                  <SecondaryButton onClick={() => setServing(machine)}>Serve a folder</SecondaryButton>
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

      {serving && <ServeOverSshDialog machine={serving} ssh={ssh} onClose={() => setServing(null)} />}
    </div>
  )
}
