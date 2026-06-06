import { useEffect, useState } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import type { RemoteConnectSpec, SshHostEntry } from '../../shared/types'
import { btn, inputCls, SEGMENT } from './Modal'

// In-panel connect form (no modal) for a remote SSH server or a WSL distro.
// Presentational: it builds a RemoteConnectSpec and hands it to `onSubmit`;
// the store action does the actual companionConnect + workspace wiring.
//
// SSH input is built around one "Connection" string (user@host:port) rather
// than a grid of boxes — paste a target or an `ssh …` command and it splits
// into the pieces. A saved-host picker prefills it from ~/.ssh/config, and the
// rarely-touched auth knobs (agent / key / passphrase) live under "Advanced".

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

/** Pure: split a connection string into its parts. Accepts `[user@]host[:port]`
 *  and a pasted `ssh …` command (strips the `ssh`, honours `-p PORT`, takes the
 *  first non-flag token as the target). Missing parts come back undefined. */
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
    s = s.split(/\s+/).filter(Boolean).find((t) => !t.startsWith('-')) ?? ''
  }
  let user: string | undefined
  const at = s.indexOf('@')
  if (at >= 0) {
    user = s.slice(0, at) || undefined
    s = s.slice(at + 1)
  }
  const colon = s.lastIndexOf(':')
  if (colon >= 0 && /^\d+$/.test(s.slice(colon + 1))) {
    port = port ?? s.slice(colon + 1)
    s = s.slice(0, colon)
  }
  return { user, host: s || undefined, port }
}

/** Render parts back into a `user@host:port` connection string. */
function formatTarget(user?: string, host?: string, port?: string | number): string {
  if (!host) return ''
  return `${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}`
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
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'server')

  // server fields — `target` is the single source for host/user/port.
  const [target, setTarget] = useState(formatTarget(initial?.user, initial?.host, initial?.port))
  const [remotePath, setRemotePath] = useState(initial?.remotePath ?? '')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [useAgent, setUseAgent] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Saved hosts from ~/.ssh/config; null = not loaded yet, [] = none/unreadable.
  const [sshHosts, setSshHosts] = useState<SshHostEntry[] | null>(null)
  const [savedAlias, setSavedAlias] = useState('')

  // wsl fields
  const [distro, setDistro] = useState(initial?.distro ?? '')
  const [distroPath, setDistroPath] = useState(initial?.distroPath ?? '')
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
    window.electronAPI
      .companionSshHosts()
      .then((hosts) => alive && setSshHosts(hosts))
      .catch(() => alive && setSshHosts([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply a ~/.ssh/config alias: fill the connection string + key, and reveal
  // Advanced when the host carries an IdentityFile so the prefill is visible.
  const pickSavedHost = (alias: string): void => {
    setSavedAlias(alias)
    const h = sshHosts?.find((e) => e.alias === alias)
    if (!h) return
    setTarget(formatTarget(h.user, h.host, h.port))
    if (h.identityFile) {
      setKeyPath(h.identityFile)
      setAdvancedOpen(true)
    }
  }

  const parsed = parseSshTarget(target)
  const canSubmit =
    !pending &&
    (kind === 'server'
      ? !!parsed.host && !!parsed.user && !!remotePath.trim()
      : (distros?.length ?? 0) > 0 && distro.trim() && distroPath.trim())

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit(
      buildConnectSpec(kind, {
        host: parsed.host ?? '',
        user: parsed.user ?? '',
        port: parsed.port ?? '',
        remotePath,
        keyPath,
        passphrase,
        useAgent,
        distro,
        distroPath,
      }),
    )
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') onCancel?.()
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4" onKeyDown={onKeyDown}>
      {/* Kind toggle — segmented control */}
      <div className={SEGMENT.group}>
        {(['server', 'wsl'] as const).map((k) => (
          <button key={k} type="button" className={SEGMENT.seg(kind === k)} onClick={() => setKind(k)}>
            {k === 'server' ? 'SSH server' : 'WSL'}
          </button>
        ))}
      </div>

      {kind === 'server' ? (
        <>
          {sshHosts && sshHosts.length > 0 && (
            <select className={`${inputCls} cursor-pointer`} value={savedAlias} onChange={(e) => pickSavedHost(e.target.value)}>
              <option value="" className="bg-surface-5 text-primary">Saved host…</option>
              {sshHosts.map((h) => (
                <option key={h.alias} value={h.alias} className="bg-surface-5 text-primary">
                  {h.alias}
                </option>
              ))}
            </select>
          )}

          <input
            className={inputCls}
            value={target}
            onChange={(e) => {
              setTarget(e.target.value)
              setSavedAlias('')
            }}
            placeholder="user@host:port"
            autoFocus
          />

          <input
            className={inputCls}
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="Remote path"
          />

          <button
            type="button"
            className="flex items-center gap-1 self-start text-[12px] text-muted hover:text-secondary transition-colors"
            onClick={() => setAdvancedOpen((o) => !o)}
          >
            <CaretRight size={12} weight="bold" className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
            Advanced
          </button>

          {advancedOpen && (
            <div className="flex flex-col gap-2.5 pl-3 border-l border-subtle">
              <label className="flex items-center gap-2 text-[12px] text-secondary cursor-pointer">
                <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} className="accent-focus-blue" />
                Use SSH agent
              </label>
              <input
                className={inputCls}
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="Private key path"
              />
              <input
                className={inputCls}
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Key passphrase"
              />
            </div>
          )}
        </>
      ) : (
        <>
          {distros === null ? (
            <div className="text-[12px] text-muted px-0.5 py-1">Looking for WSL distros…</div>
          ) : distros.length > 0 ? (
            <select className={`${inputCls} cursor-pointer`} value={distro} onChange={(e) => setDistro(e.target.value)} autoFocus>
              {distros.map((d) => (
                <option key={d} value={d} className="bg-surface-5 text-primary">
                  {d}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-[12px] text-muted px-0.5 py-1">No WSL distros found.</div>
          )}
          <input
            className={inputCls}
            value={distroPath}
            onChange={(e) => setDistroPath(e.target.value)}
            placeholder="Path in distro"
          />
        </>
      )}

      {error && (
        <div className="text-[12px] text-red-400 whitespace-pre-wrap break-words max-h-32 overflow-auto rounded-lg bg-red-500/10 border border-red-500/20 px-2.5 py-2">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 mt-1">
        {onCancel && (
          <button type="button" className={btn.ghost} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className={btn.primary} onClick={submit} disabled={!canSubmit}>
          {pending ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
