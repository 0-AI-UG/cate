// "Join a workspace": type the pairing code another device shows, pair, then
// open the workspace.

import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { Modal, Spinner, btn, inputCls } from '@kernel/ui'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { clientApp } from '../app'
import { selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { joinErrorMessage, joinWorkspace } from './join'

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function JoinWorkspaceDialog(): JSX.Element | null {
  const open = useUIStore((s) => s.joinDialogOpen)
  if (!open) return null
  return <OpenJoinDialog />
}

function OpenJoinDialog(): JSX.Element {
  const close = () => useUIStore.getState().setJoinDialogOpen(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const app = clientApp()
  const pair = app.pair

  const join = async (input: string) => {
    if (!pair || !input.trim()) return
    setBusy(true)
    setError(null)
    try {
      const entry = await joinWorkspace(input, { pair, workspaces: app.workspaces })
      close()
      if (await selectWorkspace(entry.id)) {
        // Name it after the runtime's folder once it answers.
        tryRuntimeFor(entry.id)?.runtime.info()
          .then((info) => app.workspaces.rename(entry.id, basename(info.root)))
          .catch(() => {})
      }
    } catch (err) {
      setError(joinErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={close} width={440} icon={<Link2 size={16} />} title="Join a workspace" dismissable={!busy} bodyClassName="px-5 py-4">
      {!pair ? (
        <p className="text-[13px] text-secondary">This version of Cate cannot join workspaces on other devices yet.</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void join(code)
          }}
        >
          <p className="text-[13px] leading-relaxed text-secondary">
            On a device that has the workspace open, go to Settings → Devices → Add device. Type the code it shows.
          </p>
          <input
            autoFocus
            aria-label="Pairing code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            className={`${inputCls} font-mono`}
          />
          {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} disabled={busy} className={btn.ghost}>Cancel</button>
            <button type="submit" disabled={busy || !code.trim()} className={`${btn.primary} inline-flex items-center gap-1.5`}>
              {busy && <Spinner size={12} />}
              {busy ? 'Joining…' : 'Join'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
