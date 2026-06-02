import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { RemoteConnectSpec } from '../../shared/types'
import { RemoteConnect } from '../ui/RemoteConnect'

// Centered popup wrapper for the remote-connect form. Matches the app's modal
// idiom (fixed backdrop + centered card), portaled to document.body so it
// overlays everything regardless of where it's opened from. Closes on Escape
// or a backdrop click.
export function RemoteConnectDialog({
  onSubmit,
  onClose,
  pending = false,
  error = null,
}: {
  onSubmit: (spec: RemoteConnectSpec) => void
  onClose: () => void
  pending?: boolean
  error?: string | null
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-h-[85vh] overflow-auto bg-surface-2 rounded-xl border border-subtle shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3.5 text-[13px] font-semibold text-primary">Connect to remote</div>
        <RemoteConnect onSubmit={onSubmit} onCancel={onClose} pending={pending} error={error} />
      </div>
    </div>,
    document.body,
  )
}
