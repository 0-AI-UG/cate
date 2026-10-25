// Runtime settings page (runtime/daemon's slice): what keeps the workspace
// runtime running and its machine awake, its network access, its version, and
// "Stop workspace runtime".
// The settings window hands it the workspace; the client adds what only it
// knows (its own version and the connection's state) through props.

import { useEffect, useState, type ReactNode } from 'react'
import { useRuntime } from '../../kernel/rpc'
import { SearchableBlock, SecondaryButton, Select, SettingRow, Spinner, Toggle } from '../../kernel/interaction'
import { setWorkspaceSetting, useWorkspaceSettings } from '../../kernel/settings'
import type { KeepRunningTrigger, RuntimeNetwork, RuntimeStatus } from '@runtime/daemon/contract'
import { clientUi, errorMessage } from '@kernel/interaction'
import { RunningWorkConfirm } from './RunningWork'

const REACH: Record<RuntimeNetwork, number> = { off: 0, sameNetwork: 1, cateConnect: 2 }

/** Sets network access, asking first when the change cuts devices off. */
export async function changeNetwork(workspaceId: string, from: RuntimeNetwork, to: RuntimeNetwork): Promise<void> {
  if (REACH[to] < REACH[from]) {
    const who = to === 'off'
      ? 'Every paired device disconnects'
      : 'Paired devices that are not on the same network disconnect'
    const ok = await clientUi().confirm(`${who}, this one too if it reaches the workspace that way. Only someone on its machine can turn network access back on. Continue?`)
    if (!ok) return
  }
  await setWorkspaceSetting(workspaceId, 'runtimeNetwork', to)
}

const showError = (fallback: string) => (err: unknown) => clientUi().showError(errorMessage(err, fallback))

const TRIGGERS: { trigger: KeepRunningTrigger; label: string; description: string; keywords: string }[] = [
  { trigger: 'agents', label: 'While agents work', description: 'An agent is running a turn. An agent waiting at its prompt does not count.', keywords: 'agent turn' },
  { trigger: 'commands', label: 'While commands run', description: 'A program other than an agent runs in a terminal: a build, a dev server, a script.', keywords: 'terminal command build server' },
  { trigger: 'clients', label: 'While a device is in use', description: 'Someone used a window or device of this workspace in the last 10 minutes.', keywords: 'client device phone in use' },
  { trigger: 'always', label: 'Always', description: 'Never stops on its own, and the machine never sleeps on its own.', keywords: 'always forever never stop' },
]

export interface RuntimeSettingsPageProps {
  workspaceId: string | null
  /** Panel titles for the running-work list. */
  panelTitle?: (panelId: string) => string | undefined
  /** Extra rows the client adds (its connection notice). */
  children?: ReactNode
}

export function RuntimeSettingsPage({ workspaceId, panelTitle, children }: RuntimeSettingsPageProps): JSX.Element | null {
  const runtime = useRuntime(workspaceId)
  const settings = useWorkspaceSettings(workspaceId)
  const [info, setInfo] = useState<RuntimeStatus | null>(null)
  // A failed ask ends the wait: its message and a retry replace the spinner.
  const [infoError, setInfoError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [confirmingStop, setConfirmingStop] = useState(false)

  useEffect(() => {
    let cancelled = false
    setInfo(null)
    setInfoError(null)
    runtime?.runtime.info().then(
      (i) => { if (!cancelled) setInfo(i) },
      (err) => { if (!cancelled) setInfoError(errorMessage(err, 'The runtime did not answer.')) },
    )
    return () => { cancelled = true }
  }, [runtime, attempt])

  if (!workspaceId || !runtime) return null
  const network = settings.runtimeNetwork
  const triggers = settings.keepRunningWhile

  return (
    <div className="flex flex-col gap-1">
      <SearchableBlock keywords="keep running awake sleep lifetime stop idle background">
        <div className="pt-2 pb-1 text-xs text-muted">
          Keep the runtime running and this machine awake. With none of these, the runtime stops 5 minutes after its last window closes.
        </div>
      </SearchableBlock>
      {TRIGGERS.map(({ trigger, label, description, keywords }) => (
        <SettingRow key={trigger} label={label} description={description} keywords={`keep running awake sleep ${keywords}`}>
          <Toggle
            checked={triggers.includes(trigger)}
            onChange={(on) => {
              const next = on ? [...triggers, trigger] : triggers.filter((t) => t !== trigger)
              void setWorkspaceSetting(workspaceId, 'keepRunningWhile', next).catch(showError('Could not change the setting.'))
            }}
          />
        </SettingRow>
      ))}
      <SettingRow
        label="Network access"
        keywords="pairing devices remote cate connect same network lan"
        description="Lets paired devices join this workspace. Off: only this machine can open it."
      >
        <Select
          value={network}
          onChange={(v) => { void changeNetwork(workspaceId, network, v as RuntimeNetwork).catch(showError('Could not change network access.')) }}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'sameNetwork', label: 'Same network' },
            { value: 'cateConnect', label: 'Cate Connect' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Runtime version"
        keywords="version update pid"
        description={info ? `${info.version} (protocol ${info.protocol.join('.')}), ${info.clients.length} connected client${info.clients.length === 1 ? '' : 's'}` : infoError ?? undefined}
      >
        {info ? <span />
          : infoError ? <SecondaryButton onClick={() => setAttempt((n) => n + 1)}>Retry</SecondaryButton>
          : <Spinner size={14} label="Asking the runtime" className="text-muted" />}
      </SettingRow>
      {children}
      <SettingRow
        label="Stop workspace runtime"
        keywords="stop quit kill runtime terminals agents"
        description="Ends every terminal and agent of this workspace for everyone in it."
      >
        <SecondaryButton onClick={() => setConfirmingStop(true)} disabled={confirmingStop}>Stop…</SecondaryButton>
      </SettingRow>
      {confirmingStop && (
        <div data-srow className="py-2">
          <RunningWorkConfirm
            runtime={runtime}
            actionLabel="Stop runtime"
            consequence="Stopping the runtime ends everything below for everyone in this workspace. Opening the workspace on its machine, or over SSH or WSL, starts it again; paired devices cannot."
            title={panelTitle}
            onCancel={() => setConfirmingStop(false)}
            onConfirm={async () => {
              await runtime.runtime.stop()
              setConfirmingStop(false)
            }}
          />
        </div>
      )}
    </div>
  )
}
