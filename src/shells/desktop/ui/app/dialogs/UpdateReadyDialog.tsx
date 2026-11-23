// The "update ready" dialog, shown once the desktop updater has downloaded
// an update. "Restart now" quits and installs; "Install on next quit" leaves
// it staged. A dismissed version stays quiet until a newer one arrives or the
// person checks for updates again.

import { useCallback, useEffect, useState } from 'react'
import { RotateCw as ArrowClockwise } from 'lucide-react'
import { Button, Modal } from '../../kernel/interaction'
import { useDesktopPort, type DesktopPort, type UpdateStatus } from '../desktop'

export function UpdateReadyDialog(): JSX.Element | null {
  const port = useDesktopPort()
  return port ? <UpdateReadyDialogWith port={port} /> : null
}

function UpdateReadyDialogWith({ port }: { port: DesktopPort }): JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    const apply = (status: UpdateStatus): void => {
      if (status.state === 'downloaded') {
        setVersion(status.version)
        setDismissed(status.dismissed === true)
      } else if (status.state === 'error') {
        setVersion(null)
        setRestarting(false)
      }
    }
    let active = true
    let receivedEvent = false
    const unsubscribe = port.onUpdateStatus((status) => {
      receivedEvent = true
      apply(status)
    })
    // The download may have finished before this window mounted, pull current.
    port.updateStatus().then((status) => {
      if (active && !receivedEvent) apply(status)
    }).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [port])

  const open = version !== null && !dismissed

  const later = useCallback(() => {
    if (version) void port.dismissUpdate(version).catch(() => {})
  }, [port, version])

  const restart = useCallback(async () => {
    setRestarting(true)
    try {
      const ok = await port.quitAndInstallUpdate()
      // false → nothing staged or self-update not possible here; keep the modal
      // so the user can fall back to "Install on next quit".
      if (!ok) setRestarting(false)
    } catch {
      setRestarting(false)
    }
  }, [port])

  if (!open) return null

  return (
    <Modal
      title="Cate update ready"
      icon={<ArrowClockwise size={16} />}
      width={360}
      showClose={false}
      dismissable={!restarting}
      onClose={later}
      bodyClassName="min-h-0 overflow-auto"
    >
      <div className="px-5 py-4">
        <p className="text-[13px] leading-relaxed text-secondary">
          Cate <span className="font-mono text-primary">{version}</span> is ready to install.
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted">Restart now, or install when you quit.</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-subtle bg-surface-0/40 px-5 py-3">
        <Button onClick={later} disabled={restarting}>Install on next quit</Button>
        <Button variant="primary" onClick={restart} loading={restarting} loadingLabel="Restarting…">
          <ArrowClockwise size={14} aria-hidden="true" />
          Restart now
        </Button>
      </div>
    </Modal>
  )
}
