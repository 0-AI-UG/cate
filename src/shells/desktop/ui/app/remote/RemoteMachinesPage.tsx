// "Remote machines" settings page: machines this device runs commands on.
// SSH machines are saved in the client setting `sshMachines`; WSL distros
// are listed from this machine. "Open a folder" on one sets the runtime up
// there and opens a folder as a workspace, reached through the machine's
// bridge.

import { useEffect, useState } from 'react'
import { Server, Trash2 } from 'lucide-react'
import { SearchableBlock, SecondaryButton, TextInput } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { setClientSetting, useClientSetting } from '../../kernel/settings'
import { formatSshTarget, parseSshCommand, type Machine, type SshMachine } from '@runtime/daemon/contract'
import { tryClientApp } from '../app'
import { MachineFolderDialog } from './MachineFolderDialog'
import { withMachine } from './paths'

/** The machine whose folder dialog is open; `saved` is the SSH machine it
 *  belongs to, or the one to save once it answers. */
interface Opening {
  machine: Machine
  saved?: SshMachine
}

export function RemoteMachinesPage(): JSX.Element {
  const setup = tryClientApp()?.machines
  const machines = useClientSetting('sshMachines')
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<Opening | null>(null)
  const [distros, setDistros] = useState<string[]>([])

  useEffect(() => {
    let live = true
    setup?.wslDistros().then((list) => { if (live) setDistros(list) }, () => {})
    return () => { live = false }
  }, [setup])

  if (!setup) {
    return <p className="text-[13px] text-secondary">This version of Cate cannot open folders on other machines.</p>
  }

  const add = () => {
    const parsed = parseSshCommand(command)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    const same = machines.find((m) => formatSshTarget(m.target) === formatSshTarget(parsed.target))
    const saved = same ?? { id: crypto.randomUUID(), target: parsed.target }
    setCommand('')
    setError(null)
    // A new machine is saved once it answered.
    setOpening({ machine: { kind: 'ssh', target: saved.target }, saved })
  }

  const remember = (saved: SshMachine | undefined, lastPath?: string) => {
    if (!saved) return
    const current = machines.find((m) => m.id === saved.id) ?? saved
    setClientSetting('sshMachines', withMachine(machines, lastPath ? { ...current, lastPath } : current))
  }

  const remove = async (machine: SshMachine) => {
    const ok = await clientUi().confirm(
      `Remove ${machine.target.destination}? Its workspaces stay in the sidebar.`,
    )
    if (ok) setClientSetting('sshMachines', machines.filter((m) => m.id !== machine.id))
  }

  return (
    <div className="flex flex-col gap-1">
      <SearchableBlock keywords="ssh remote machine server vps install open folder">
        <div className="py-3 border-b border-subtle flex flex-col gap-2">
          <span className="text-[13px] font-medium text-primary">Add machine</span>
          <span className="text-xs text-muted">
            Cate signs in with the system ssh, using your SSH config, keys and agent, installs its runtime there the
            first time, and opens a folder you pick as a workspace. Everything travels over SSH. A host seen for the
            first time is added to known_hosts.
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
                  <SecondaryButton onClick={() => setOpening({ machine: { kind: 'ssh', target: machine.target }, saved: machine })}>
                    Open a folder
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

      {distros.length > 0 && (
        <SearchableBlock keywords="wsl linux distro windows subsystem">
          <div className="py-3 border-t border-subtle flex flex-col gap-2">
            <span className="text-[13px] font-medium text-primary">WSL</span>
            <span className="text-xs text-muted">
              Opens a folder inside a WSL distro: terminals, git and agents run in Linux.
            </span>
            <ul className="flex flex-col" aria-label="WSL distros">
              {distros.map((distro) => (
                <li key={distro} className="flex items-center gap-3 py-1.5">
                  <span className="flex-1 min-w-0 text-[13px] text-primary font-mono truncate">{distro}</span>
                  <SecondaryButton onClick={() => setOpening({ machine: { kind: 'wsl', distro } })}>Open a folder</SecondaryButton>
                </li>
              ))}
            </ul>
          </div>
        </SearchableBlock>
      )}

      {opening && (
        <MachineFolderDialog
          machine={opening.machine}
          setup={setup}
          lastPath={opening.saved?.lastPath}
          onReady={() => remember(opening.saved)}
          onOpened={(path) => remember(opening.saved, path)}
          onClose={() => setOpening(null)}
        />
      )}
    </div>
  )
}
