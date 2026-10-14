// "Join with a Code": type the pairing code another device shows (Share →
// Show pairing code there), or open its link, pair, then open the workspace.

import { useState } from 'react'
import { Link2 } from 'lucide-react'
import { Modal, btn, inputCls, Spinner } from '../../kernel/interaction'
import { clientApp } from '../app'
import { selectWorkspace } from '../navigation'
import { useUIStore, type JoinRequest } from '../state/uiStore'
import { joinErrorMessage, joinWorkspace } from '@client/workspaces'

export function JoinWorkspaceDialog(): JSX.Element | null {
  const request = useUIStore((s) => s.joinDialog)
  if (!request) return null
  // A new request (another link opened) starts the dialog over.
  return <OpenJoinDialog key={`${request.code ?? ''}|${request.machine ?? ''}`} request={request} />
}

function OpenJoinDialog({ request }: { request: JoinRequest }): JSX.Element {
  const close = () => useUIStore.getState().closeJoinDialog()
  const [code, setCode] = useState(request.code ?? '')
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
      useUIStore.getState().setOpenDialogOpen(false)
      // It takes the runtime's folder name once it connects (nameJoinedWorkspaces).
      await selectWorkspace(entry.id)
    } catch (err) {
      setError(joinErrorMessage(err))
      setBusy(false)
    }
  }

  const where = request.machine ? `On ${request.machine}` : 'On the device that has the workspace open'

  return (
    <Modal onClose={close} width={440} icon={<Link2 size={16} />} title="Join with a code" dismissable={!busy} bodyClassName="px-5 py-4">
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
            {where}, click Share and create a code. Type the code here.
          </p>
          <input
            autoFocus
            aria-label="Pairing code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            className={`${inputCls} font-mono`}
          />
          {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} disabled={busy} className={btn.ghost}>Cancel</button>
            <button type="submit" disabled={busy || !code.trim()} className={`${btn.primary} inline-flex items-center gap-1.5`}>
              {busy && <Spinner size={12} />}
              {busy ? 'Joining' : 'Join'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
