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
import { setWorkspaceSetting, t as tNow, useT, useWorkspaceSetting } from '../../kernel/settings'
import { closeChoiceOf, closeChoiceTriggers, type CloseChoice, type KeepRunningTrigger, type RuntimeNetwork, type RuntimeStatus } from '@runtime/daemon/contract'
import type { WorkspaceDevice } from '@runtime/pairing/contract'
import { clientUi, errorMessage } from '@kernel/interaction'
import { RunningWorkConfirm } from './RunningWork'

const REACH: Record<RuntimeNetwork, number> = { off: 0, sameNetwork: 1, cateConnect: 2 }

/** Sets network access, asking first when the change cuts devices off. */
export async function changeNetwork(workspaceId: string, from: RuntimeNetwork, to: RuntimeNetwork): Promise<void> {
  if (REACH[to] < REACH[from]) {
    const who = to === 'off'
      ? tNow('Every paired device disconnects')
      : tNow('Paired devices that are not on the same network disconnect')
    const ok = await clientUi().confirm(tNow('{who}, this one too if it reaches the workspace that way. Only someone on its machine can turn network access back on. Continue?', { who }))
    if (!ok) return
  }
  await setWorkspaceSetting(workspaceId, 'runtimeNetwork', to)
}

const showError = (fallback: string) => (err: unknown) => clientUi().showError(errorMessage(err, fallback))

/** "A", "A and B", or "3 paired devices". */
function deviceNames(devices: readonly WorkspaceDevice[]): string {
  if (devices.length > 2) return tNow('{count} paired devices', { count: devices.length })
  if (devices.length === 2) return tNow('{a} and {b}', { a: devices[0].name, b: devices[1].name })
  return devices.map((d) => d.name).join('')
}

export interface AvailabilitySettingsProps {
  workspaceId: string | null
  /** Panel titles for the running-work list. */
  panelTitle?: (panelId: string) => string | undefined
  renderPanelTitle?: (panelId: string) => ReactNode
  /** Names of the devices connected now, this one first. */
  connected?: readonly string[]
  /** Opens adding a device (Share). */
  onAddDevice?: () => void
  /** Extra rows the client adds (its connection notice). */
  children?: ReactNode
}

export function AvailabilitySettings({ workspaceId, panelTitle, renderPanelTitle, connected, onAddDevice, children }: AvailabilitySettingsProps): JSX.Element | null {
  const runtime = useRuntime(workspaceId)
  const triggers = useWorkspaceSetting(workspaceId, 'keepRunningWhile')
  const [info, setInfo] = useState<RuntimeStatus | null>(null)
  // A failed ask ends the wait: its message and a retry replace the spinner.
  const [infoError, setInfoError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [devices, setDevices] = useState<WorkspaceDevice[] | null>(null)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const t = useT()

  useEffect(() => {
    let cancelled = false
    setInfo(null)
    setInfoError(null)
    runtime?.runtime.info().then(
      (i) => { if (!cancelled) setInfo(i) },
      (err) => { if (!cancelled) setInfoError(errorMessage(err, tNow('The runtime did not answer.'))) },
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
  const machine = info?.machineName ?? t('its computer')
  // Unknown (still asking, or an older runtime): worded for one that sleeps.
  const server = info?.machineSleeps === false
  const choice = closeChoiceOf(triggers)
  const commands = triggers.includes('commands')
  const paired = devices?.filter((d) => d.admittedBy === 'pairing') ?? []
  const set = (next: KeepRunningTrigger[]) => {
    void setWorkspaceSetting(workspaceId, 'keepRunningWhile', next).catch(showError(t('Could not change the setting.')))
  }

  const descriptions: Record<CloseChoice | 'custom', string> = {
    finish: server
      ? t(commands ? 'Agents and commands keep going until they are done, then it stops. Opening it over SSH starts it again.' : 'Agents keep going until they are done, then it stops. Opening it over SSH starts it again.')
      : t(commands ? 'Agents and commands keep going until they are done. {machine} stays awake until then, then sleeps as usual.' : 'Agents keep going until they are done. {machine} stays awake until then, then sleeps as usual.', { machine }),
    always: server
      ? t('Keeps running so collaborators and your other devices can connect at any time.')
      : t('Keeps running and keeps {machine} awake, so collaborators and your other devices can connect at any time. Uses more battery.', { machine }),
    stop: t('Everything stops 5 minutes after the last window closes.'),
    custom: t('Set by hand in this workspace\'s settings.json. Picking another option replaces it.'),
  }
  const always = { value: 'always', label: server ? 'Keep available (recommended)' : 'Keep available' }
  const options = [
    // A server is meant to stay available: that comes first.
    ...(server ? [always] : []),
    { value: 'finish', label: 'Finish running work' },
    ...(server ? [] : [always]),
    { value: 'stop', label: 'Stop with Cate' },
    ...(choice === 'custom' ? [{ value: 'custom', label: 'Custom' }] : []),
  ]

  const link = 'text-focus-blue hover:underline'
  const hint = paired.length > 0 && choice !== 'always' ? (
    <span className="block text-xs text-warning">
      {t(server ? '{devices} cannot connect once the workspace stops.' : '{devices} cannot connect once the workspace stops or {machine} sleeps.', { devices: deviceNames(paired), machine })}{' '}
      <button type="button" className={link} onClick={() => set(closeChoiceTriggers('always'))}>{t('Stay available')}</button>
    </span>
  ) : paired.length === 0 && devices && onAddDevice ? (
    <span className="block text-xs text-muted">
      {t('Work together or connect your other device.')} <button type="button" className={link} onClick={onAddDevice}>{t('Share workspace…')}</button>
    </span>
  ) : undefined

  const connectedLine = connected && connected.length > 0
    ? t('Connected: {names}', { names: connected.join(', ') })
    : info ? t(info.clients.length === 1 ? '{count} device connected' : '{count} devices connected', { count: info.clients.length }) : null
  const version = info ? `Cate ${info.version}` : null

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="After closing Cate"
        description={descriptions[choice]}
        keywords="keep running awake sleep battery background close quit leave agents commands always available finish stop server"
        hint={hint}
      >
        <Select value={choice} onChange={(v) => { if (v !== 'custom') set(closeChoiceTriggers(v as CloseChoice)) }} options={options} />
      </SettingRow>
      {choice === 'finish' && (
        <SettingRow
          label="Include terminal commands"
          description={t(server ? 'Builds, dev servers and scripts keep it running too.' : 'Builds, dev servers and scripts keep it running too and {machine} awake.', { machine })}
          keywords="keep running awake terminal command build dev server script"
        >
          <Toggle checked={commands} onChange={(on) => set(closeChoiceTriggers('finish', on))} />
        </SettingRow>
      )}
      <SettingRow
        label={info ? t(server ? 'Running on {machine} (server)' : 'Running on {machine}', { machine }) : 'Running'}
        description={[connectedLine, version ?? infoError].filter(Boolean).join(' · ') || undefined}
        keywords="runtime machine server connected devices clients version stop quit kill terminals agents"
      >
        <div className="flex items-center gap-2">
          {!info && (infoError
            ? <SecondaryButton onClick={() => setAttempt((n) => n + 1)}>{t('Retry')}</SecondaryButton>
            : <Spinner size={14} label={t('Asking the runtime')} className="text-muted" />)}
          <SecondaryButton onClick={() => setConfirmingStop(true)} disabled={confirmingStop}>{t('Stop Workspace…')}</SecondaryButton>
        </div>
      </SettingRow>
      {children}
      {confirmingStop && (
        <div data-srow className="py-2">
          <RunningWorkConfirm
            runtime={runtime}
            actionLabel={t('Stop workspace')}
            consequence={t('Stopping ends everything below for everyone in this workspace. Opening the workspace on its machine, or over SSH or WSL, starts it again; paired devices cannot.')}
            title={panelTitle}
            renderPanelTitle={renderPanelTitle}
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
