import { useState } from 'react'
import { GitCompareArrows as GitDiff } from 'lucide-react'
import { errorMessage } from '@kernel/interaction'
import { Tooltip } from '../../kernel/interaction'
import { agentChangesOpener } from './changesOpener'

const FAILED = 'Could not open agent changes'

export function AgentChangesPill({ workspaceId, panelId }: { workspaceId: string; panelId: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <>
    <Tooltip label={error || 'Changes from this panel'}>
      <button type="button" aria-label="Open agent changes" disabled={busy}
        className="flex h-6 w-6 items-center justify-center rounded-[10px] text-muted hover:bg-hover hover:text-primary disabled:opacity-50"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={async (event) => {
          event.stopPropagation()
          const open = agentChangesOpener()
          if (busy || !open) return
          setBusy(true); setError('')
          try {
            if (!(await open({ workspaceId, panelId }))) setError(FAILED)
          } catch (cause) { setError(errorMessage(cause, FAILED)) }
          finally { setBusy(false) }
        }}>
        <GitDiff size={14} />
      </button>
    </Tooltip>
    {error && <span role="alert" className="max-w-48 rounded bg-surface-2 px-2 text-[10px] text-red-400">{error}</span>}
  </>
}
