// "Devices" settings page of a workspace: add a device (turn on network
// access if it is off, then show a one-time QR code and pairing code with its
// expiry), and every device that has opened the workspace, paired or as a
// user of the runtime's machine, with revoke.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Smartphone, Trash2 } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { SecondaryButton, Select, SearchableBlock, Spinner } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { setWorkspaceSetting, useWorkspaceSetting } from '../../kernel/settings'
import type { CreatedSecret, PairingMode, WorkspaceDevice } from '@runtime/pairing/contract'
import { clientIdentity } from '@client/connections'
import { useOtherClients } from '../../client/document'
import type { SettingsPageProps } from '../settings/registry'

export function DevicesPage({ workspaceId }: SettingsPageProps): JSX.Element | null {
  if (!workspaceId) return null
  return (
    <div className="flex flex-col gap-1">
      <AddDevice workspaceId={workspaceId} />
      <WorkspaceDevices workspaceId={workspaceId} />
    </div>
  )
}

/** Seconds left until `expiresAt`, ticking. */
function useSecondsLeft(expiresAt: number | null, now: () => number = Date.now): number {
  const [left, setLeft] = useState(() => (expiresAt ? Math.max(0, Math.ceil((expiresAt - now()) / 1000)) : 0))
  useEffect(() => {
    if (!expiresAt) return
    const tick = () => setLeft(Math.max(0, Math.ceil((expiresAt - now()) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [expiresAt, now])
  return left
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function AddDevice({ workspaceId }: { workspaceId: string }): JSX.Element {
  const runtime = useRuntime(workspaceId)
  const network = useWorkspaceSetting(workspaceId, 'runtimeNetwork')
  const [mode, setMode] = useState<PairingMode>('sameNetwork')
  const [secret, setSecret] = useState<CreatedSecret | null>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const secondsLeft = useSecondsLeft(secret?.expiresAt ?? null)
  const expired = secret !== null && secondsLeft === 0

  useEffect(() => {
    if (network !== 'off') setMode(network)
  }, [network])

  useEffect(() => {
    if (!secret) { setQrSvg(null); return }
    let cancelled = false
    QRCode.toString(secret.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => { if (!cancelled) setQrSvg(svg) }, () => { if (!cancelled) setQrSvg(null) })
    return () => { cancelled = true }
  }, [secret])

  const create = async () => {
    if (!runtime) return
    setBusy(true)
    setError(null)
    try {
      // Only ever widens access: Cate Connect serves the same network too.
      if (network === 'off' || (network === 'sameNetwork' && mode === 'cateConnect')) {
        await setWorkspaceSetting(workspaceId, 'runtimeNetwork', mode)
      }
      setSecret(await runtime.pairing.createSecret({ mode }))
    } catch (err) {
      setError(errorMessage(err, 'Could not create a pairing code.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SearchableBlock keywords="add device pair pairing qr code phone join network">
      <div className="py-3 border-b border-subtle flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col min-w-0">
            <span className="text-[13px] font-medium text-primary">Add device</span>
            <span className="text-xs text-muted mt-0.5">
              {network === 'off'
                ? 'Turns on network access for this workspace, then shows a one-time code for the other device.'
                : 'Shows a one-time code. Scan it with the other device, or type the code there under "Join a workspace".'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Select
              value={mode}
              onChange={(v) => setMode(v as PairingMode)}
              options={[
                { value: 'sameNetwork', label: 'Same network' },
                { value: 'cateConnect', label: 'Cate Connect' },
              ]}
            />
            <SecondaryButton onClick={() => void create()} disabled={!runtime || busy}>
              {busy ? <Spinner size={12} /> : <Smartphone size={12} />}
              {secret && !expired ? 'New code' : 'Add device'}
            </SecondaryButton>
          </div>
        </div>
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
        {secret && (
          <div className="flex items-center gap-5" aria-label="Pairing code">
            <div
              className={`w-36 h-36 shrink-0 rounded-lg bg-white p-1.5 ${expired ? 'opacity-20' : ''}`}
              data-testid="pairing-qr"
              // The SVG is generated locally by qrcode from the runtime's link.
              dangerouslySetInnerHTML={qrSvg ? { __html: qrSvg } : undefined}
            />
            <div className="flex flex-col gap-2 min-w-0">
              <code className={`text-[15px] font-mono tracking-wider text-primary select-all ${expired ? 'line-through text-muted' : ''}`}>
                {secret.code.toUpperCase()}
              </code>
              <span className="text-xs text-muted">
                {expired ? 'Expired. Make a new code.' : `Works once. Expires in ${formatCountdown(secondsLeft)}.`}
              </span>
            </div>
          </div>
        )}
      </div>
    </SearchableBlock>
  )
}

export function WorkspaceDevices({ workspaceId }: { workspaceId: string }): JSX.Element {
  const runtime = useRuntime(workspaceId)
  const others = useOtherClients(workspaceId)
  const [devices, setDevices] = useState<WorkspaceDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ownKey = clientIdentity().device.publicKey
  const online = new Set([ownKey, ...others.map((client) => client.device.publicKey)])

  // Live: a device paired, connected or removed from another client shows
  // here too.
  useEffect(() => {
    if (!runtime) return
    const watch = runtime.pairing.watch(undefined, { resume: true })
    watch.onEvent((event) => {
      setDevices(event.kind === 'snapshot' ? event.snapshot : event.change)
      setError(null)
    })
    watch.done.catch((err: unknown) => setError(errorMessage(err, 'Could not list the devices.')))
    return () => watch.cancel()
  }, [runtime])

  const revoke = async (device: WorkspaceDevice) => {
    if (!runtime) return
    const consequence = device.admittedBy === 'pairing'
      ? 'It can no longer open this workspace until it pairs again.'
      : 'It is disconnected, and comes back when it opens the workspace again as a user of this machine.'
    if (!(await clientUi().confirm(`Remove "${device.name}"? ${consequence}`))) return
    try {
      await runtime.pairing.revoke({ deviceKey: device.publicKey })
    } catch (err) {
      clientUi().showError(errorMessage(err, 'Could not remove the device.'))
    }
  }

  return (
    <SearchableBlock keywords="devices paired revoke remove phone">
      <div className="py-3 flex flex-col gap-2">
        <span className="text-[13px] font-medium text-primary">Devices</span>
        {error && <span className="text-xs text-danger">{error}</span>}
        {devices === null ? (
          !error && <Spinner size={12} />
        ) : devices.length === 0 ? (
          <span className="text-xs text-muted">No device has opened this workspace.</span>
        ) : (
          <ul className="flex flex-col" aria-label="Devices">
            {devices.map((device) => (
              <li key={device.publicKey} data-device-key={device.publicKey} className="flex items-center gap-3 py-1.5">
                <span
                  aria-label={online.has(device.publicKey) ? 'Connected' : 'Not connected'}
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${online.has(device.publicKey) ? 'bg-green-500' : 'bg-transparent'}`}
                />
                <Smartphone size={14} className="text-muted shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[13px] text-primary truncate">
                    {device.name}
                    {device.publicKey === ownKey && <span className="text-muted"> (this device)</span>}
                  </span>
                  <span className="text-[11px] text-muted font-mono truncate">
                    {device.fingerprint} · {device.admittedBy === 'pairing' ? 'paired' : "as this machine's user"} · last seen {new Date(device.lastSeen).toLocaleString()}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${device.name}`}
                  onClick={() => void revoke(device)}
                  className="w-7 h-7 flex items-center justify-center rounded-md text-muted hover:text-red-400 hover:bg-hover"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SearchableBlock>
  )
}
