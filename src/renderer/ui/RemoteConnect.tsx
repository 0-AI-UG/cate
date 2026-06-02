import { useEffect, useState } from 'react'
import type { RemoteConnectSpec } from '../../shared/types'

// In-panel connect form (no modal) for a remote SSH server or a WSL distro.
// Presentational: it builds a RemoteConnectSpec and hands it to `onSubmit`;
// the store action does the actual companionConnect + workspace wiring.

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

/** Pure: assemble a validated RemoteConnectSpec from raw form fields. */
export function buildConnectSpec(kind: Kind, f: RemoteConnectFields): RemoteConnectSpec {
  if (kind === 'wsl') {
    return { kind: 'wsl', distro: f.distro.trim(), distroPath: f.distroPath.trim() }
  }
  const portNum = f.port.trim() ? Number(f.port.trim()) : undefined
  return {
    kind: 'server',
    host: f.host.trim(),
    user: f.user.trim(),
    port: portNum !== undefined && Number.isFinite(portNum) ? portNum : undefined,
    remotePath: f.remotePath.trim(),
    auth: {
      keyPath: f.keyPath.trim() || undefined,
      passphrase: f.passphrase || undefined,
      useAgent: f.useAgent,
    },
  }
}

const inputCls =
  'w-full text-[13px] bg-surface-3 border border-subtle rounded px-2 py-1 outline-none text-primary focus:border-focus-blue'
const labelCls = 'text-[11px] uppercase tracking-wider text-muted mb-1'

export function RemoteConnect({
  onSubmit,
  onCancel,
  pending = false,
  error = null,
}: {
  onSubmit: (spec: RemoteConnectSpec) => void
  onCancel?: () => void
  pending?: boolean
  error?: string | null
}) {
  const [kind, setKind] = useState<Kind>('server')

  // server fields
  const [host, setHost] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [useAgent, setUseAgent] = useState(true)

  // wsl fields
  const [distro, setDistro] = useState('')
  const [distroPath, setDistroPath] = useState('')
  // Installed distros for the picker; null = not loaded yet. Empty (non-Windows /
  // no WSL / probe failed) falls back to a free-text input.
  const [distros, setDistros] = useState<string[] | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI
      .companionWslDistros()
      .then((list) => {
        if (!alive) return
        setDistros(list)
        if (list.length && !distro) setDistro(list[0])
      })
      .catch(() => alive && setDistros([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canSubmit =
    !pending &&
    (kind === 'server'
      ? host.trim() && user.trim() && remotePath.trim()
      : (distros?.length ?? 0) > 0 && distro.trim() && distroPath.trim())

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit(buildConnectSpec(kind, { host, user, port, remotePath, keyPath, passphrase, useAgent, distro, distroPath }))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') onCancel?.()
  }

  return (
    <div className="flex flex-col gap-2.5 p-4" onKeyDown={onKeyDown}>
      {/* Kind toggle */}
      <div className="flex gap-1 text-[12px]">
        {(['server', 'wsl'] as const).map((k) => (
          <button
            key={k}
            className={`px-2 py-1 rounded ${kind === k ? 'bg-surface-3 text-primary' : 'text-muted hover:text-secondary'}`}
            onClick={() => setKind(k)}
          >
            {k === 'server' ? 'SSH server' : 'WSL'}
          </button>
        ))}
      </div>

      {kind === 'server' ? (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <div className={labelCls}>Host</div>
              <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" autoFocus />
            </div>
            <div className="w-24">
              <div className={labelCls}>Port</div>
              <input className={inputCls} value={port} onChange={(e) => setPort(e.target.value)} placeholder="22" />
            </div>
          </div>
          <div>
            <div className={labelCls}>User</div>
            <input className={inputCls} value={user} onChange={(e) => setUser(e.target.value)} placeholder="ubuntu" />
          </div>
          <div>
            <div className={labelCls}>Remote path</div>
            <input className={inputCls} value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/home/ubuntu/project" />
          </div>
          <label className="flex items-center gap-2 text-[12px] text-secondary">
            <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} />
            Use SSH agent
          </label>
          <div>
            <div className={labelCls}>Private key path (optional)</div>
            <input className={inputCls} value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
          </div>
          <div>
            <div className={labelCls}>Key passphrase (optional)</div>
            <input className={inputCls} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </div>
        </>
      ) : (
        <>
          <div>
            <div className={labelCls}>Distro</div>
            {distros === null ? (
              <div className="text-[12px] text-muted px-2 py-1">Looking for WSL distros…</div>
            ) : distros.length > 0 ? (
              <select className={inputCls} value={distro} onChange={(e) => setDistro(e.target.value)} autoFocus>
                {distros.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-[12px] text-muted px-2 py-1">No WSL distros found on this machine.</div>
            )}
          </div>
          <div>
            <div className={labelCls}>Path in distro</div>
            <input className={inputCls} value={distroPath} onChange={(e) => setDistroPath(e.target.value)} placeholder="/home/me/project" />
          </div>
        </>
      )}

      {error && (
        <div className="text-[12px] text-red-400 whitespace-pre-wrap break-words max-h-32 overflow-auto rounded bg-red-500/10 border border-red-500/20 px-2 py-1.5">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2 mt-1">
        <button
          className={`px-3 py-1 rounded text-[13px] ${canSubmit ? 'bg-focus-blue text-white hover:opacity-90' : 'bg-surface-3 text-muted cursor-default'}`}
          onClick={submit}
          disabled={!canSubmit}
        >
          {pending ? 'Connecting…' : 'Connect'}
        </button>
        {onCancel && (
          <button className="px-2 py-1 rounded text-[13px] text-muted hover:text-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
