// "Devices" settings page of a workspace: every device that has opened it,
// paired or as a user of the runtime's machine, with revoke; adding one is
// Share's. Also the one-time pairing code (QR and typed, with its expiry)
// that Share shows.

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { Button, SecondaryButton, SearchableBlock, SettingRow, Spinner } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { setWorkspaceSetting, useWorkspaceSetting } from '../../kernel/settings'
import type { CreatedSecret, PairingMode, WorkspaceDevice } from '@runtime/pairing/contract'
import { clientIdentity, relativeTime } from '@client/connections'
import { useOtherClients } from '../../client/document'
import type { SettingsPageProps } from '../settings/registry'
import { useUIStore } from '../state/uiStore'

export function DevicesPage({ workspaceId }: SettingsPageProps): JSX.Element | null {
  if (!workspaceId) return null
  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Add a device"
        description="Share the workspace to choose who can join and show a one-time code."
        keywords="add device pair pairing qr code phone join network share"
      >
        <SecondaryButton onClick={() => useUIStore.getState().openShare(workspaceId)}>Share…</SecondaryButton>
      </SettingRow>
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

/** A one-time code (QR and typed) for another device to join with. Network
 *  access off: creating it turns on same-network access first. */
export function PairingCode({ workspaceId }: { workspaceId: string }): JSX.Element {
  const runtime = useRuntime(workspaceId)
  const network = useWorkspaceSetting(workspaceId, 'runtimeNetwork')
  const [secret, setSecret] = useState<CreatedSecret | null>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const secondsLeft = useSecondsLeft(secret?.expiresAt ?? null)
  const expired = secret !== null && secondsLeft === 0

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
      const mode: PairingMode = network === 'off' ? 'sameNetwork' : network
      if (network === 'off') await setWorkspaceSetting(workspaceId, 'runtimeNetwork', mode)
      setSecret(await runtime.pairing.createSecret({ mode }))
    } catch (err) {
      setError(errorMessage(err, 'Could not create a pairing code.'))
    } finally {
      setBusy(false)
    }
  }

  const howTo = 'On the other device, scan the QR code or type the code under "Join with a Code".'

  if (!secret) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-subtle bg-surface-0 px-6 py-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-hover text-secondary">
          <QrCode size={18} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[14px] font-medium text-primary">Add a device</span>
          <span className="max-w-[340px] text-xs leading-relaxed text-muted">
            Show a one-time code here. {howTo}
            {network === 'off' && ' Turns on same-network access first.'}
          </span>
        </div>
        <Button variant="primary" onClick={() => void create()} disabled={!runtime} loading={busy}>
          Show pairing code
        </Button>
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-5 rounded-xl border border-subtle bg-surface-0 p-4" aria-label="Pairing code">
      <div
        className={`h-36 w-36 shrink-0 rounded-lg bg-white p-1.5 ${expired ? 'opacity-20' : ''}`}
        data-testid="pairing-qr"
        // The SVG is generated locally by qrcode from the runtime's link.
        dangerouslySetInnerHTML={qrSvg ? { __html: qrSvg } : undefined}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-[14px] font-medium text-primary">Add a device</span>
        <span className="text-xs leading-relaxed text-muted">{howTo}</span>
        <code className={`break-all font-mono text-[15px] tracking-wider select-all ${expired ? 'text-muted line-through' : 'text-primary'}`}>
          {secret.code.toUpperCase()}
        </code>
        <div className="flex items-center justify-between gap-3">
          <span className={`text-xs ${expired ? 'text-danger' : 'text-muted'}`}>
            {expired ? 'Expired.' : `Works once. Expires in ${formatCountdown(secondsLeft)}.`}
          </span>
          <Button size="sm" variant={expired ? 'primary' : 'ghost'} onClick={() => void create()} disabled={!runtime} loading={busy}>
            <RefreshCw size={11} />
            New code
          </Button>
        </div>
        {error && <span role="alert" className="text-xs text-danger">{error}</span>}
      </div>
    </div>
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
        <span className="text-[13px] font-medium text-primary">
          Devices{devices && devices.length > 0 && <span className="ml-1.5 font-normal text-muted">{devices.length}</span>}
        </span>
        {error && <span className="text-xs text-danger">{error}</span>}
        {devices === null ? (
          !error && <Spinner size={12} />
        ) : devices.length === 0 ? (
          <span className="text-xs text-muted">No device has opened this workspace.</span>
        ) : (
          <ul className="-mx-2 flex flex-col" aria-label="Devices">
            {devices.map((device) => {
              const connected = online.has(device.publicKey)
              return (
                <li key={device.publicKey} data-device-key={device.publicKey} className="group/device flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
                  <span className="relative shrink-0 text-muted">
                    <Smartphone size={15} />
                    <span
                      aria-label={connected ? 'Connected' : 'Not connected'}
                      className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-surface-0 ${connected ? 'bg-green-500' : 'bg-transparent border-transparent'}`}
                    />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] text-primary">
                      {device.name}
                      {device.publicKey === ownKey && <span className="text-muted"> (this device)</span>}
                    </span>
                    <span className="truncate text-[11px] text-muted" title={`Fingerprint ${device.fingerprint}`}>
                      {device.admittedBy === 'pairing' ? 'Paired' : "Joined as this machine's user"} · {connected ? 'connected now' : `last seen ${relativeTime(device.lastSeen)}`}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${device.name}`}
                    onClick={() => void revoke(device)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted opacity-0 hover:bg-hover hover:text-red-400 focus:opacity-100 group-hover/device:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </SearchableBlock>
  )
}
