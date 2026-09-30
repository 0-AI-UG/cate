// "Devices" settings page of a workspace: add a device (turn on network
// access if it is off, then show a one-time QR code and pairing code with its
// expiry), and the paired devices with revoke.

import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Smartphone, Trash2 } from 'lucide-react'
import { useRuntime } from '@kernel/rpc/ui'
import { SecondaryButton, Select, SearchableBlock, Spinner, clientUi, errorMessage } from '@kernel/ui'
import { setWorkspaceSetting, useWorkspaceSetting } from '@kernel/settings/ui'
import type { CreatedSecret, PairedDevice, PairingMode } from '@runtime/pairing/contract'
import type { SettingsPageProps } from '../settings/registry'

export function DevicesPage({ workspaceId }: SettingsPageProps): JSX.Element | null {
  if (!workspaceId) return null
  return (
    <div className="flex flex-col gap-1">
      <AddDevice workspaceId={workspaceId} />
      <PairedDevices workspaceId={workspaceId} />
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
      if (network !== mode) await setWorkspaceSetting(workspaceId, 'runtimeNetwork', mode)
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

export function PairedDevices({ workspaceId }: { workspaceId: string }): JSX.Element {
  const runtime = useRuntime(workspaceId)
  const [devices, setDevices] = useState<PairedDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!runtime) return
    try {
      setDevices(await runtime.pairing.list())
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Could not list paired devices.'))
    }
  }, [runtime])

  useEffect(() => { void refresh() }, [refresh])

  const revoke = async (device: PairedDevice) => {
    if (!runtime) return
    if (!(await clientUi().confirm(`Remove "${device.name}"? It can no longer open this workspace until it pairs again.`))) return
    try {
      await runtime.pairing.revoke({ deviceKey: device.publicKey })
    } catch (err) {
      clientUi().showError(errorMessage(err, 'Could not remove the device.'))
    }
    await refresh()
  }

  return (
    <SearchableBlock keywords="paired devices revoke remove phone">
      <div className="py-3 flex flex-col gap-2">
        <span className="text-[13px] font-medium text-primary">Paired devices</span>
        {error && <span className="text-xs text-danger">{error}</span>}
        {devices === null ? (
          !error && <Spinner size={12} />
        ) : devices.length === 0 ? (
          <span className="text-xs text-muted">No other device can open this workspace.</span>
        ) : (
          <ul className="flex flex-col" aria-label="Paired devices">
            {devices.map((device) => (
              <li key={device.publicKey} className="flex items-center gap-3 py-1.5">
                <Smartphone size={14} className="text-muted shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[13px] text-primary truncate">{device.name}</span>
                  <span className="text-[11px] text-muted font-mono truncate">
                    {device.fingerprint} · last seen {new Date(device.lastSeen).toLocaleString()}
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
