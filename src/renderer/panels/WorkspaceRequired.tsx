import type { ReactNode } from 'react'
import { useAppStore } from '../stores/appStore'
import { workspaceAvailability } from '../lib/workspace/workspaceAvailability'
import { ensureWorkspaceFolder } from '../lib/runAction'
import { Button } from '../ui/Button'
import { LoadingState } from '../ui/Spinner'

/** Shared mount boundary for all panel types, including persistent guests. */
export function WorkspaceRequired({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const availability = useAppStore((s) => workspaceAvailability(s.workspaces.find((w) => w.id === workspaceId)))
  if (availability === 'ready') return <>{children}</>
  return <div data-workspace-required className="flex h-full min-h-0 items-center justify-center overflow-auto p-6">
    {availability === 'opening' ? <LoadingState label="Opening workspace…" /> : <div className="flex flex-col items-center gap-3 text-center">
      <p className="text-sm text-secondary">No workspace selected</p>
      <p className="text-xs text-muted">Choose a project folder to use this panel.</p>
      <Button size="sm" onClick={() => void ensureWorkspaceFolder(workspaceId)}>Open folder…</Button>
    </div>}
  </div>
}
