import { useState } from 'react'
import { GitCompareArrows as GitDiff } from 'lucide-react'
import { tryRuntimeFor } from '@kernel/rpc/client'
import { errorMessage } from '@kernel/ui'
import { peekAgentPanels } from '../client'
import { agentChangesOpener } from './changesOpener'

const FAILED = 'Could not open agent changes'

/** The checkout the agent works in: its session's, else the one the caller
 *  knows (the panel's worktree), else the workspace root. */
async function checkoutOf(workspaceId: string, panelId: string, checkout: string | undefined): Promise<string | null> {
  const cwd = peekAgentPanels(workspaceId)[panelId]?.session?.cwd ?? checkout
  if (cwd) return cwd
  const runtime = tryRuntimeFor(workspaceId)
  return runtime ? (await runtime.workspace.info()).root : null
}

export function AgentChangesPill({ workspaceId, panelId, checkout }: { workspaceId: string; panelId: string; checkout?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <>
    <button type="button" aria-label="Open agent changes" title={error || 'Changes from this panel'} disabled={busy}
      className="group inline-flex h-[18px] items-center gap-0 rounded-full bg-surface-3 px-1 text-secondary transition-[gap] hover:gap-1 hover:text-primary disabled:opacity-50"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={async (event) => {
        event.stopPropagation()
        const open = agentChangesOpener()
        if (busy || !open) return
        setBusy(true); setError('')
        try {
          const cwd = await checkoutOf(workspaceId, panelId, checkout)
          if (cwd && !(await open({ workspaceId, panelId, cwd }))) setError(FAILED)
        } catch (cause) { setError(errorMessage(cause, FAILED)) }
        finally { setBusy(false) }
      }}>
      <GitDiff size={11} />
      <span className="max-w-0 overflow-hidden text-[10px] transition-all group-hover:max-w-20">Changes</span>
    </button>
    {error && <span role="alert" className="max-w-48 rounded bg-surface-2 px-2 text-[10px] text-red-400">{error}</span>}
  </>
}
