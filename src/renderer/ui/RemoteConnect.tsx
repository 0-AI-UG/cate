import { useEffect, useState } from 'react'
import type { RemoteConnectSpec, RuntimeConnection, SshHostEntry } from '../../shared/types'
import {
  ABSOLUTE_RUNTIME_PATH_ERROR,
  assertAbsoluteRuntimePath,
  isAbsoluteRuntimePath,
} from '../../shared/runtimeLocator'
import { isRemoteRuntimeConnection } from '../../shared/runtimeConnection'
import { SettingRow, TextInput, Select, SecondaryButton } from '../settings/SettingsComponents'
import { SettingsSearchContext } from '../settings/SettingsSearchContext'
import { Button } from './Button'
import { LoadingState } from './Spinner'

// Settings form for a saved SSH or WSL connection. Saving never opens a workspace.
// Presentational: it builds a RemoteConnectSpec and hands it to `onSubmit`;
// the settings store persists the profile and main stores SSH credentials.
//
// SSH input is built around one "Connection" string (user@host:port) rather
// than a grid of boxes — paste a target or an `ssh …` command and it splits
// into the pieces. A saved-host picker prefills it from ~/.ssh/config, and the
// authentication controls (agent / key / passphrase) live in a disclosure.

type Kind = 'server' | 'wsl'

export interface RemoteConnectFields {
  host: string
  user: string
  port: string
  remotePath: string
  keyPath: string
  passphrase: string
  useAgent: boolean
  distro: string
  distroPath: string
}

function sshTargetError(rawHost: string, port: string): string | null {
  const host = rawHost.trim()
  const singleColon = host.includes(':') && host.indexOf(':') === host.lastIndexOf(':')
  if (!host || /[\s/@[\]]/.test(host) || singleColon || host.startsWith('-')) {
    return 'Enter a valid SSH host or config alias.'
  }
  const portNum = port.trim() ? Number(port) : undefined
  if (portNum !== undefined && (!/^\d+$/.test(port.trim()) || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
    return 'Port must be a whole number between 1 and 65535.'
  }
  return null
}

/** Pure: assemble a validated RemoteConnectSpec from raw form fields. */
export function buildConnectSpec(kind: Kind, f: RemoteConnectFields): RemoteConnectSpec {
  if (kind === 'wsl') {
    const distroPath = f.distroPath.trim()
    assertAbsoluteRuntimePath(distroPath)
    if (!f.distro.trim()) throw new Error('Choose a WSL distribution.')
    return { kind: 'wsl', distro: f.distro.trim(), distroPath }
  }
  const remotePath = f.remotePath.trim()
  assertAbsoluteRuntimePath(remotePath)
  const targetError = sshTargetError(f.host, f.port)
  if (targetError) throw new Error(targetError)
  const portNum = f.port.trim() ? Number(f.port) : undefined
  return {
    kind: 'server',
    host: f.host.trim(),
    user: f.user.trim(),
    port: portNum,
    remotePath,
    auth: {
      keyPath: f.keyPath.trim() || undefined,
      passphrase: f.passphrase || undefined,
      useAgent: f.useAgent,
    },
  }
}

/** Pure: split a connection string into its parts. Accepts `[user@]host[:port]`
 *  and a pasted `ssh [-p PORT] host` command. Other options are rejected;
 *  configure them in OpenSSH instead of silently discarding them. Missing parts come back undefined. */
export function parseSshTarget(raw: string): { user?: string; host?: string; port?: string } {
  let s = raw.trim()
  if (!s) return {}
  let port: string | undefined
  if (/^ssh\b/i.test(s)) {
    s = s.replace(/^ssh\b/i, ' ')
    const pm = s.match(/(?:^|\s)-p\s*(\d+)\b/)
    if (pm) {
      port = pm[1]
      s = s.replace(pm[0], ' ')
    }
    // Never mistake an option argument (such as an identity file) for a host.
    if (s.trim().split(/\s+/).length !== 1 || s.trim().startsWith('-')) return {}
    s = s.trim()
  }
  let user: string | undefined
  const at = s.indexOf('@')
  if (at >= 0) {
    user = s.slice(0, at) || undefined
    s = s.slice(at + 1)
  }
  const bracketed = s.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (bracketed) return { user, host: bracketed[1], port: port ?? bracketed[2] }
  const colon = s.lastIndexOf(':')
  if (s.indexOf(':') === colon && colon >= 0 && /^\d+$/.test(s.slice(colon + 1))) {
    port = port ?? s.slice(colon + 1)
    s = s.slice(0, colon)
  }
  return { user, host: s || undefined, port }
}

/** Render parts back into a `user@host:port` connection string. */
function formatTarget(user?: string, host?: string, port?: string | number): string {
  if (!host) return ''
  return `${user ? `${user}@` : ''}${host.includes(':') ? `[${host}]` : host}${port ? `:${port}` : ''}`
}

/** Non-secret fields that can be pre-filled when editing an existing
 *  connection. SSH key/passphrase live in safeStorage and are never echoed
 *  back, so they're re-entered (or left blank to reuse the stored secret). */
export interface RemoteConnectInitial {
  kind?: Kind
  host?: string
  user?: string
  port?: string
  remotePath?: string
  distro?: string
  distroPath?: string
}

/** Pre-fill values for the edit-connection form from a stored connection. */
export function connectionInitial(connection: RuntimeConnection | undefined) {
  if (!isRemoteRuntimeConnection(connection)) return undefined
  if (connection.kind === 'wsl') {
    return { kind: 'wsl' as const, distro: connection.distro, distroPath: connection.distroPath }
  }
  return {
    kind: 'server' as const,
    host: connection.host,
    user: connection.user,
    port: connection.port != null ? String(connection.port) : '',
    remotePath: connection.remotePath,
  }
}

export function RemoteConnect({
  onSubmit,
  onCancel,
  pending = false,
  error = null,
  initial,
}: {
  onSubmit: (spec: RemoteConnectSpec) => void
  onCancel?: () => void
  pending?: boolean
  error?: string | null
  /** Pre-fill the form to edit an existing connection (see RemoteConnectInitial). */
  initial?: RemoteConnectInitial
}) {
  const [authChanged, setAuthChanged] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'server')

  // server fields — `target` is the single source for host/user/port.
  const [target, setTarget] = useState(formatTarget(initial?.user, initial?.host, initial?.port))
  const [remotePath, setRemotePath] = useState(initial?.remotePath ?? '')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [useAgent, setUseAgent] = useState(true)
  // Saved hosts from ~/.ssh/config; null = not loaded yet, [] = none/unreadable.
  const [sshHosts, setSshHosts] = useState<SshHostEntry[] | null>(null)
  const [savedAlias, setSavedAlias] = useState('')

  // wsl fields
  const [distro, setDistro] = useState(initial?.distro ?? '')
  const [distroPath, setDistroPath] = useState(initial?.distroPath ?? '')
  // Installed distros for the picker; null = not loaded yet.
  const [distros, setDistros] = useState<string[] | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      .runtimeWslDistros()
      .then((list) => {
        if (!alive) return
        setDistros(list)
        if (list.length && !distro) setDistro(list[0])
      })
      .catch(() => alive && setDistros([]))
    window.electronAPI
      .runtimeSshHosts()
      .then((hosts) => alive && setSshHosts(hosts))
      .catch(() => alive && setSshHosts([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Preserve the alias exactly. The main process passes it to system OpenSSH,
  // which resolves User/HostName/Port, certificates, agents, and proxy rules
  // from the complete configuration (including Include and Match blocks).
  const pickSavedHost = (alias: string): void => {
    setSavedAlias(alias)
    const h = sshHosts?.find((e) => e.alias === alias)
    if (!h) return
    setTarget(h.alias)
  }

  const parsed = parseSshTarget(target)
  const activePath = (kind === 'server' ? remotePath : distroPath).trim()
  const pathError = activePath && !isAbsoluteRuntimePath(activePath)
    ? ABSOLUTE_RUNTIME_PATH_ERROR
    : null
  const targetError = kind === 'server' && target.trim()
    ? sshTargetError(parsed.host ?? '', parsed.port ?? '')
    : null
  const canSubmit =
    !pending &&
    !pathError && !targetError &&
    (kind === 'server'
      ? !!parsed.host && !!remotePath.trim()
      : !!distro.trim() && !!distroPath.trim())

  const submit = (): void => {
    if (!canSubmit) return
    const spec = buildConnectSpec(kind, {
      host: parsed.host ?? '',
      user: parsed.user ?? '',
      port: parsed.port ?? '',
      remotePath,
      keyPath,
      passphrase,
      useAgent,
      distro,
      distroPath,
    })
    if (spec.kind === 'server' && spec.auth && initial && !authChanged) delete spec.auth.useAgent
    onSubmit(spec)
  }

  return (
    <SettingsSearchContext.Provider value={{ query: '', sectionMatched: true }}>
      <form aria-label={initial ? 'Edit remote connection' : 'New remote connection'} aria-busy={pending} onSubmit={(e) => { e.preventDefault(); submit() }}>
        <fieldset disabled={pending} className="min-w-0 disabled:opacity-60">
          <SettingRow label="Connection type">
            <Select value={kind} onChange={(value) => setKind(value as Kind)} options={[{ value: 'server', label: 'SSH server' }, { value: 'wsl', label: 'WSL' }]} />
          </SettingRow>
          {kind === 'server' ? <>
            {!!sshHosts?.length && <SettingRow label="SSH config host" description="Use an alias from this computer’s SSH configuration.">
              <Select value={savedAlias} onChange={pickSavedHost} options={[{ value: '', label: 'Choose a host…' }, ...sshHosts.map((h) => ({ value: h.alias, label: h.alias }))]} />
            </SettingRow>}
            <SettingRow label="SSH host" description="Host, user@host:port, or SSH config alias." hint={targetError ? <span role="alert" className="text-danger">{targetError}</span> : undefined}>
              <TextInput value={target} onChange={(value) => { setTarget(value); setSavedAlias('') }} placeholder="user@host:port" layoutClassName="w-64 px-2" />
            </SettingRow>
            <SettingRow label="Project folder" description="Absolute path on the remote machine." hint={pathError ? <span role="alert" className="text-danger">{pathError}</span> : undefined}>
              <TextInput value={remotePath} onChange={setRemotePath} placeholder="/home/you/project" layoutClassName="w-64 px-2" />
            </SettingRow>
            <SettingRow label="SSH agent" description="SSH also uses your system config, including proxy and jump hosts.">
              <Select value={initial && !authChanged ? 'saved' : useAgent ? 'enabled' : 'disabled'} onChange={(value) => { setAuthChanged(value !== 'saved'); setUseAgent(value === 'enabled') }} options={[
                ...(initial ? [{ value: 'saved', label: 'Keep saved preference' }] : []),
                { value: 'enabled', label: 'Use SSH agent' }, { value: 'disabled', label: 'Do not use SSH agent' },
              ]} />
            </SettingRow>
            <SettingRow label="Private key" description={initial ? 'Leave empty to keep the saved key.' : 'Optional when provided by your SSH config or agent.'}>
              <div className="flex items-center gap-2">
                <TextInput value={keyPath} onChange={setKeyPath} placeholder="~/.ssh/id_ed25519" />
                <SecondaryButton onClick={() => {
                  void window.electronAPI.runtimePickSshKey().then((path) => { if (path) setKeyPath(path) })
                    .catch(() => setLocalError('Could not open the key picker. Enter the key path instead.'))
                }}>Browse…</SecondaryButton>
              </div>
            </SettingRow>
            <SettingRow label="Key passphrase" description={initial ? 'Leave empty to keep the saved passphrase.' : 'Stored securely on this computer.'}>
              <TextInput value={passphrase} onChange={setPassphrase} type="password" placeholder="Optional" layoutClassName="w-64 px-2" />
            </SettingRow>
          </> : <>
            <SettingRow label="WSL distribution" description="Requires Windows with WSL installed.">
              {distros === null ? <LoadingState label="Looking for distributions…" size={13} /> : distros.length ?
                <Select value={distro} onChange={setDistro} options={[
                  ...(!distros.includes(distro) && distro ? [{ value: distro, label: `${distro} (unavailable)` }] : []),
                  ...distros.map((d) => ({ value: d, label: d })),
                ]} /> : <TextInput value={distro} onChange={setDistro} placeholder="Ubuntu" />}
            </SettingRow>
            <SettingRow label="Project folder" description="Absolute path inside the distribution." hint={pathError ? <span role="alert" className="text-danger">{pathError}</span> : undefined}>
              <TextInput value={distroPath} onChange={setDistroPath} placeholder="/home/you/project" layoutClassName="w-64 px-2" />
            </SettingRow>
          </>}
        </fieldset>
        {(error || localError) && <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-xs text-danger">{error || localError}</p>}
        <div className="flex justify-end gap-2 py-3">
          {onCancel && <SecondaryButton disabled={pending} onClick={onCancel}>Cancel</SecondaryButton>}
          <Button size="sm" type="submit" disabled={!canSubmit} loading={pending} loadingLabel="Saving…">Save connection</Button>
        </div>
      </form>
    </SettingsSearchContext.Provider>
  )
}
