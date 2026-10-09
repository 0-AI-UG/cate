// Runtime settings page (runtime/daemon's slice): how long the workspace
// runtime runs, its network access, its version, and "Stop workspace runtime".
// The settings window hands it the workspace; the client adds what only it
// knows (its own version and the connection's state) through props.

import { useEffect, useState, type ReactNode } from 'react'
import { useRuntime } from '../../kernel/rpc'
import { SecondaryButton, Select, SettingRow, Spinner } from '../../kernel/interaction'
import { setWorkspaceSetting, useWorkspaceSettings } from '../../kernel/settings'
import type { RuntimeLifetime, RuntimeNetwork, RuntimeStatus } from '@runtime/daemon/contract'
import { RunningWorkConfirm } from './RunningWork'

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
  const [confirmingStop, setConfirmingStop] = useState(false)

  useEffect(() => {
    let cancelled = false
    setInfo(null)
    runtime?.runtime.info().then((i) => { if (!cancelled) setInfo(i) }, () => {})
    return () => { cancelled = true }
  }, [runtime])

  if (!workspaceId || !runtime) return null
  const network = settings.runtimeNetwork

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Keep running"
        keywords="lifetime stop idle background"
        description={network !== 'off'
          ? 'Always on while network access is on, so other devices can reach it.'
          : 'Whether terminals and agents keep running after every window of this workspace is closed.'}
      >
        <Select
          value={settings.runtimeLifetime}
          onChange={(v) => { void setWorkspaceSetting(workspaceId, 'runtimeLifetime', v as RuntimeLifetime).catch(() => {}) }}
          options={[
            { value: 'stopWhenIdle', label: 'Stop when idle' },
            { value: 'keepRunning', label: 'Keep running' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Network access"
        keywords="pairing devices remote cate connect same network lan"
        description="Lets paired devices join this workspace. Off: only this machine can open it."
      >
        <Select
          value={network}
          onChange={(v) => { void setWorkspaceSetting(workspaceId, 'runtimeNetwork', v as RuntimeNetwork).catch(() => {}) }}
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
        description={info ? `${info.version} (protocol ${info.protocol.join('.')}), ${info.clients.length} connected client${info.clients.length === 1 ? '' : 's'}` : undefined}
      >
        {info ? <span /> : <Spinner size={14} label="Asking the runtime" className="text-muted" />}
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
            consequence="Stopping the runtime ends everything below for everyone in this workspace. Opening the workspace again starts it."
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
