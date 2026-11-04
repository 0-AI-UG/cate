// Joining stays in the workspace picker, including prefilled pairing links.

import { useState } from 'react'
import { joinErrorMessage, joinWorkspace } from '@client/workspaces'
import { KeyRound } from 'lucide-react'
import { InlinePickerInput } from '../remote/InlinePickerInput'
import { clientApp } from '../app'
import { selectWorkspace } from '../navigation'
import { useUIStore, type JoinRequest } from '../state/uiStore'

export function InlineJoinForm({ request }: { request: JoinRequest }): JSX.Element {
  const [code, setCode] = useState(request.code ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const app = clientApp()
  const join = async () => {
    if (!app.pair || !code.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const entry = await joinWorkspace(code, { pair: app.pair, workspaces: app.workspaces })
      useUIStore.getState().closeWorkspacePicker()
      await selectWorkspace(entry.id)
    } catch (err) {
      setError(joinErrorMessage(err))
      setBusy(false)
    }
  }

  return (
    <InlinePickerInput
      icon={<KeyRound size={14} />}
      label="Pairing code"
      placeholder="Pairing code or link"
      value={code}
      onChange={(value) => { setCode(value); setError(null) }}
      onSubmit={() => void join()}
      onCancel={() => useUIStore.getState().closeJoinInput()}
      actionLabel="Join workspace"
      busyLabel="Joining"
      busy={busy}
      disabled={!app.pair}
      error={error}
      hint={request.machine ? `Code from ${request.machine}` : undefined}
    />
  )
}
