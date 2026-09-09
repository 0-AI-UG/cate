import { useEffect, useState } from 'react'
import type { RuntimePhase, RuntimeStatus } from '../../shared/types'
import { runtimeConnectionLabel, runtimeConnectionPath, type RemoteRuntimeConnection } from '../../shared/runtimeConnection'
import { useAppStore } from '../stores/appStore'
import { useRemoteConnectionsStore } from '../stores/remoteConnectionsStore'
import { RemoteConnect, connectionInitial } from '../ui/RemoteConnect'
import { SearchableBlock, SecondaryButton, SettingRow } from './SettingsComponents'
import { SettingsSearchContext } from './SettingsSearchContext'

const phaseLabels: Record<RuntimePhase, string> = {
  connected: 'Connected', connecting: 'Connecting…', installing: 'Installing…',
  disconnected: 'Disconnected', unreachable: 'Connection failed', missing: 'Runtime setup required',
}

function ConnectionSettings({ connection }: { connection: RemoteRuntimeConnection }) {
  const workspaceStatus = useAppStore((s) => s.workspaces.find((w) => w.connection?.kind !== 'local' && w.connection?.runtimeId === connection.runtimeId)?.runtime)
  const [status, setStatus] = useState<RuntimeStatus | undefined>()
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const runtime = status ?? workspaceStatus
  const busy = pending || runtime?.phase === 'connecting' || runtime?.phase === 'installing'
  useEffect(() => window.electronAPI.onRuntimeStatus((event) => {
    if (event.runtimeId === connection.runtimeId) setStatus({ phase: event.phase, error: event.message })
  }), [connection.runtimeId])

  async function run(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try { await action() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setPending(false) }
  }
  async function check(install = false) {
    setStatus({ phase: install ? 'installing' : 'connecting' })
    try {
      const result = await (install ? window.electronAPI.runtimeInstall(connection) : window.electronAPI.runtimeEnsure(connection))
      if (result.ok) setStatus({ phase: 'connected' })
      else {
        setStatus((current) => current?.phase === 'missing' ? current : { phase: 'unreachable', error: result.error })
        throw new Error(result.error)
      }
    } catch (err) {
      setStatus((current) => current?.phase === 'connecting' || current?.phase === 'installing' ? { phase: 'unreachable' } : current)
      throw err
    }
  }
  return <div>
    <SettingRow label={runtimeConnectionLabel(connection)} description={`${connection.kind === 'wsl' ? 'WSL' : 'SSH'}${connection.kind === 'server' && connection.port ? ` · Port ${connection.port}` : ''} · ${runtimeConnectionPath(connection)}`} hint={
      <span role="status" className={runtime?.phase === 'connected' ? 'text-diff-add' : 'text-muted'}>{runtime ? phaseLabels[runtime.phase] : 'Saved'}</span>
    }>
      <div className="flex items-center gap-2">
        <SecondaryButton disabled={busy} onClick={() => void run(() => check(runtime?.phase === 'missing'))}>{runtime?.phase === 'missing' ? 'Install runtime' : 'Check connection'}</SecondaryButton>
        <SecondaryButton disabled={busy} onClick={() => { setEditing(!editing); setError(null) }}>{editing ? 'Hide' : 'Edit'}</SecondaryButton>
        <SecondaryButton disabled={busy} onClick={() => void run(() => useRemoteConnectionsStore.getState().remove(connection.runtimeId))}>Remove</SecondaryButton>
      </div>
    </SettingRow>
    {(error || runtime?.error) && !editing && <p role="alert" className="py-2 text-xs text-danger whitespace-pre-wrap break-words">{error || runtime?.error}</p>}
    {runtime?.phase === 'missing' && !editing && <p className="py-2 text-xs text-muted">Install Cate’s runtime to use this connection. Project files stay in place.</p>}
    {editing && runtime && runtime.phase !== 'missing' && <SettingRow label="Runtime installation" description="Uninstalling disconnects this runtime. Project files and the saved connection are kept.">
      <div className="flex items-center gap-2">
        {confirmUninstall && <SecondaryButton disabled={busy} onClick={() => setConfirmUninstall(false)}>Cancel</SecondaryButton>}
        <SecondaryButton disabled={busy} onClick={() => {
          if (!confirmUninstall) { setConfirmUninstall(true); return }
          void run(async () => {
            const result = await window.electronAPI.runtimeDelete(connection)
            if (!result.ok) throw new Error(result.error ?? 'Could not uninstall the runtime')
            setStatus({ phase: 'missing' })
            setConfirmUninstall(false)
          })
        }}>{confirmUninstall ? 'Confirm uninstall' : 'Uninstall runtime…'}</SecondaryButton>
      </div>
    </SettingRow>}
    {editing && <RemoteConnect initial={connectionInitial(connection)} pending={pending} error={error} onCancel={() => setEditing(false)} onSubmit={(spec) => void run(async () => {
      await useRemoteConnectionsStore.getState().save(spec, connection.runtimeId)
      setEditing(false)
    })} />}
  </div>
}

export function RemoteSettings() {
  const { connections, loaded, error: loadError, load, save } = useRemoteConnectionsStore()
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void load() }, [load])
  return <SearchableBlock keywords="remote connections ssh server hosts authentication private key passphrase agent WSL Linux reconnect runtime install">
    <SettingsSearchContext.Provider value={{ query: '', sectionMatched: true }}>
      <div className="flex flex-col gap-1">
        <SettingRow label="Saved connections" description="Manage SSH and WSL connections here, then choose one from an empty workspace. Closing a workspace keeps its saved connection.">
          <SecondaryButton disabled={adding || !loaded} onClick={() => { setAdding(true); setError(null) }}>Add connection</SecondaryButton>
        </SettingRow>
        {loadError && <p role="alert" className="py-2 text-xs text-danger">{loadError} <SecondaryButton onClick={() => void load()}>Retry</SecondaryButton></p>}
        {!loaded && !loadError && <p role="status" className="py-3 text-xs text-muted">Loading connections…</p>}
        {adding && <RemoteConnect pending={pending} error={error} onCancel={() => setAdding(false)} onSubmit={async (spec) => {
          setPending(true)
          setError(null)
          try { await save(spec); setAdding(false) }
          catch (err) { setError(err instanceof Error ? err.message : String(err)) }
          finally { setPending(false) }
        }} />}
        {connections.map((connection) => <ConnectionSettings key={connection.runtimeId} connection={connection} />)}
        {loaded && !connections.length && !adding && <p className="py-3 text-xs text-muted">No saved connections. Add an SSH server or WSL project to get started.</p>}
      </div>
    </SettingsSearchContext.Provider>
  </SearchableBlock>
}
