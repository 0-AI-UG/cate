// =============================================================================
// WorkspaceTrustBanner — shown when a project's saved layout asked to open
// panels that Cate withheld because the project isn't trusted.
//
// The safe outcome is the DEFAULT: the passive layout is already on screen and
// doing nothing here leaves it that way. The banner exists to explain the gap
// and offer the informed opt-in, not to demand a decision — so dismissing costs
// nothing (the notice returns on the next open until the project is trusted).
//
// See sessionTrustFilter.ts for what gets withheld and why (GHSA-8769-jp52-985f).
// =============================================================================

import { useState } from 'react'
import { Warning, X } from '@phosphor-icons/react'
import { useWorkspaceTrustStore } from '../stores/workspaceTrustStore'
import { describeWithheld } from '../lib/workspace/sessionTrustFilter'
import { trustProjectAndReload } from '../lib/workspace/projectTrustGate'
import log from '../lib/logger'

interface Props {
  workspaceId: string
}

export function WorkspaceTrustBanner({ workspaceId }: Props): JSX.Element | null {
  const notice = useWorkspaceTrustStore((s) => s.withheld[workspaceId])
  const clearWithheld = useWorkspaceTrustStore((s) => s.clearWithheld)
  const [restoring, setRestoring] = useState(false)

  if (!notice) return null

  const summary = describeWithheld(notice.summary)

  const onRestore = async (): Promise<void> => {
    setRestoring(true)
    try {
      await trustProjectAndReload(workspaceId, notice.locator)
    } catch (err) {
      log.warn('[trust] restore-after-trust failed: %s', err)
      setRestoring(false)
    }
  }

  return (
    <div
      role="status"
      className="flex items-center gap-3 px-3 py-2 text-xs border-b border-amber-500/30 bg-amber-500/10 text-amber-100"
    >
      <Warning size={16} weight="fill" className="shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">This project&apos;s saved layout wasn&apos;t fully restored.</span>{' '}
        <span className="opacity-80">
          It asked to open {summary}, which can run code on your machine. Restore it only if you
          trust this project.
        </span>
      </div>
      <button
        type="button"
        onClick={() => void onRestore()}
        disabled={restoring}
        className="shrink-0 px-2 py-1 rounded border border-amber-400/40 hover:bg-amber-400/20 disabled:opacity-50"
      >
        {restoring ? 'Restoring…' : 'Trust and restore'}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => clearWithheld(workspaceId)}
        className="shrink-0 p-1 rounded hover:bg-amber-400/20"
      >
        <X size={14} />
      </button>
    </div>
  )
}
