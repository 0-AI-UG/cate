import { CloudArrowUp } from '@phosphor-icons/react'
import type { RemoteConnectSpec } from '../../shared/types'
import { Modal } from '../ui/Modal'
import { RemoteConnect, type RemoteConnectInitial } from '../ui/RemoteConnect'

// Centered popup wrapper for the remote-connect form. Uses the shared <Modal>
// primitive (portal + glass card + header + esc/backdrop close), so it matches
// every other dialog in the app. The form itself lives in <RemoteConnect>.
export function RemoteConnectDialog({
  onSubmit,
  onClose,
  pending = false,
  error = null,
  initial,
}: {
  onSubmit: (spec: RemoteConnectSpec) => void
  onClose: () => void
  pending?: boolean
  error?: string | null
  initial?: RemoteConnectInitial
}) {
  return (
    <Modal
      onClose={onClose}
      width={380}
      icon={<CloudArrowUp size={16} weight="fill" className="text-focus-blue" />}
      title={initial ? 'Edit connection' : 'Connect to remote'}
      dismissable={!pending}
    >
      <RemoteConnect onSubmit={onSubmit} onCancel={onClose} pending={pending} error={error} initial={initial} />
    </Modal>
  )
}
