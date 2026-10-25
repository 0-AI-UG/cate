// Availability settings page (runtime/daemon's slice): where the workspace
// runs and who is connected (with Stop), and what happens when the person
// closes Cate, as three choices over `keepRunningWhile` worded for the machine
// (one that sleeps, or a server), with a hint about paired devices.
// The settings window hands it the workspace; the client adds what only it
// knows (who is connected, the connection's state, adding a device) through
// props.

import { useEffect, useState, type ReactNode } from 'react'
import { useRuntime } from '../../kernel/rpc'
import { SecondaryButton, Select, SettingRow, Spinner, Toggle } from '../../kernel/interaction'
import { setWorkspaceSetting, useWorkspaceSetting } from '../../kernel/settings'
import { closeChoiceOf, closeChoiceTriggers, type CloseChoice, type KeepRunningTrigger, type RuntimeNetwork, type RuntimeStatus } from '@runtime/daemon/contract'
import type { WorkspaceDevice } from '@runtime/pairing/contract'
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

/** "A", "A and B", or "3 paired devices". */
function deviceNames(devices: readonly WorkspaceDevice[]): string {
  if (devices.length > 2) return `${devices.length} paired devices`
  return devices.map((d) => d.name).join(' and ')
}

export interface AvailabilitySettingsProps {
  workspaceId: string | null
  /** Panel titles for the running-work list. */
  panelTitle?: (panelId: string) => string | undefined
  /** Names of the devices connected now, this one first. */
  connected?: readonly string[]
  /** Opens adding a device (Share). */
  onAddDevice?: () => void
  /** Extra rows the client adds (its connection notice). */
  children?: ReactNode
}

export function AvailabilitySettings({ workspaceId, panelTitle, connected, onAddDevice, children }: AvailabilitySettingsProps): JSX.Element | null {
  const runtime = useRuntime(workspaceId)
  const triggers = useWorkspaceSetting(workspaceId, 'keepRunningWhile')
  const [info, setInfo] = useState<RuntimeStatus | null>(null)
  // A failed ask ends the wait: its message and a retry replace the spinner.
  const [infoError, setInfoError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [devices, setDevices] = useState<WorkspaceDevice[] | null>(null)
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

  // Live: a device paired or removed elsewhere changes the hint.
  useEffect(() => {
    if (!runtime) return
    const watch = runtime.pairing.watch(undefined, { resume: true })
    watch.onEvent((event) => setDevices(event.kind === 'snapshot' ? event.snapshot : event.change))
    watch.done.catch(() => setDevices(null))
    return () => watch.cancel()
  }, [runtime])

  if (!workspaceId || !runtime) return null
  const machine = info?.machineName ?? 'its computer'
  // Unknown (still asking, or an older runtime): worded for one that sleeps.
  const server = info?.machineSleeps === false
  const choice = closeChoiceOf(triggers)
  const commands = triggers.includes('commands')
  const paired = devices?.filter((d) => d.admittedBy === 'pairing') ?? []
  const set = (next: KeepRunningTrigger[]) => {
    void setWorkspaceSetting(workspaceId, 'keepRunningWhile', next).catch(showError('Could not change the setting.'))
  }

  const descriptions: Record<CloseChoice | 'custom', string> = {
    finish: server
      ? `Agents${commands ? ' and commands' : ''} keep going until they are done, then it stops. Opening it over SSH starts it again.`
      : `Agents${commands ? ' and commands' : ''} keep going until they are done. ${machine} stays awake until then, then sleeps as usual.`,
    always: server
      ? 'Keeps running so you can connect from any device at any time.'
      : `Keeps running and keeps ${machine} awake, so your other devices can connect at any time. Uses more battery.`,
    stop: 'Everything stops 5 minutes after the last window closes.',
    custom: 'Set by hand in this workspace\'s settings.json. Picking another option replaces it.',
  }
  const always = { value: 'always', label: server ? 'Always stay available (recommended)' : 'Always stay available' }
  const options = [
    // A server is meant to stay available: that comes first.
    ...(server ? [always] : []),
    { value: 'finish', label: 'Finish what\'s running, then stop' },
    ...(server ? [] : [always]),
    { value: 'stop', label: 'Stop with Cate' },
    ...(choice === 'custom' ? [{ value: 'custom', label: 'Custom' }] : []),
  ]

  const link = 'text-focus-blue hover:underline'
  const hint = paired.length > 0 && choice !== 'always' ? (
    <span className="block text-xs text-warning">
      {deviceNames(paired)} cannot connect once the workspace stops{server ? '' : ` or ${machine} sleeps`}.{' '}
      <button type="button" className={link} onClick={() => set(closeChoiceTriggers('always'))}>Stay available</button>
    </span>
  ) : paired.length === 0 && devices && onAddDevice ? (
    <span className="block text-xs text-muted">
      Want to use Cate from your phone? <button type="button" className={link} onClick={onAddDevice}>Add a device</button>
    </span>
  ) : undefined

  const connectedLine = connected && connected.length > 0
    ? `Connected: ${connected.join(', ')}`
    : info ? `${info.clients.length} device${info.clients.length === 1 ? '' : 's'} connected` : null
  const version = info ? `Cate ${info.version} (protocol ${info.protocol.join('.')})` : null

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="When you close Cate"
        description={descriptions[choice]}
        keywords="keep running awake sleep battery background close quit leave agents commands always available finish stop server"
        hint={hint}
      >
        <Select value={choice} onChange={(v) => { if (v !== 'custom') set(closeChoiceTriggers(v as CloseChoice)) }} options={options} />
      </SettingRow>
      {choice === 'finish' && (
        <SettingRow
          label="Include terminal commands"
          description={`Builds, dev servers and scripts keep it running too${server ? '' : ` and ${machine} awake`}.`}
          keywords="keep running awake terminal command build dev server script"
        >
          <Toggle checked={commands} onChange={(on) => set(closeChoiceTriggers('finish', on))} />
        </SettingRow>
      )}
      <SettingRow
        label={info ? `Running on ${machine}${server ? ' (server)' : ''}` : 'Running'}
        description={[connectedLine, version ?? infoError].filter(Boolean).join(' · ') || undefined}
        keywords="runtime machine server connected devices clients version protocol stop quit kill terminals agents"
      >
        <div className="flex items-center gap-2">
          {!info && (infoError
            ? <SecondaryButton onClick={() => setAttempt((n) => n + 1)}>Retry</SecondaryButton>
            : <Spinner size={14} label="Asking the runtime" className="text-muted" />)}
          <SecondaryButton onClick={() => setConfirmingStop(true)} disabled={confirmingStop}>Stop…</SecondaryButton>
        </div>
      </SettingRow>
      {children}
      {confirmingStop && (
        <div data-srow className="py-2">
          <RunningWorkConfirm
            runtime={runtime}
            actionLabel="Stop workspace"
            consequence="Stopping ends everything below for everyone in this workspace. Opening the workspace on its machine, or over SSH or WSL, starts it again; paired devices cannot."
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
