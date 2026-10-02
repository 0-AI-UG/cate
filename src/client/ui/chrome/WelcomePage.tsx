// The welcome screen a window shows with no workspace: open a folder on this
// device, join a workspace from another device, reopen a recent one, and the
// shortcuts worth knowing.

import type { ReactNode } from 'react'
import { Folder, FolderOpen, Link2 } from 'lucide-react'
import { useDeclaredActions, useResolvedShortcuts } from '@kernel/ui'
import { canRunAction, useActionsVersion } from '@client/host'
import { displayString } from '@kernel/ui/contract'
import { useWorkspaceList } from '@client/workspaces/ui'
import { clientApp } from '../app'
import { useDesktopPort } from '../desktop'
import { pickAndOpenFolder, selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { CateLogo } from './CateLogo'

function parentOf(root: string): string {
  const parts = root.split(/[\\/]/)
  return parts.slice(0, -1).join('/')
}

export function WelcomePage(): JSX.Element {
  const shortcuts = useResolvedShortcuts()
  useActionsVersion()
  const welcome = useDeclaredActions().filter(({ id, spec }) => spec.welcome && canRunAction(id, { workspaceId: null }))
  const desktop = useDesktopPort()
  const { entries } = useWorkspaceList(clientApp().workspaces)
  const recent = entries.slice(0, 8)

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div className="pointer-events-auto max-w-2xl w-full px-8">
        <div className="flex flex-col items-center mb-10">
          <CateLogo size={56} className="h-8 w-auto text-primary mb-2" aria-label="Cate" />
          <p className="text-sm text-muted mt-1">Infinite canvas for coding</p>
        </div>

        <div className="flex gap-12">
          <div data-onboarding="welcome-actions" className="flex-1">
            <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-3">Start</h2>
            <div className="flex flex-col gap-1">
              {desktop && (
                <ActionItem
                  icon={<FolderOpen size={16} />}
                  label="Open Folder..."
                  shortcut={shortcuts.openFolder?.key ? displayString(shortcuts.openFolder) : undefined}
                  onClick={() => void pickAndOpenFolder()}
                />
              )}
              <ActionItem
                icon={<Link2 size={16} />}
                label="Join a Workspace..."
                onClick={() => useUIStore.getState().setJoinDialogOpen(true)}
              />
            </div>
          </div>

          {recent.length > 0 && (
            <div className="flex-1">
              <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-3">Recent</h2>
              <div className="flex flex-col gap-0.5">
                {recent.map((entry) => (
                  <button
                    key={entry.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-hover transition-colors group"
                    onClick={() => void selectWorkspace(entry.id)}
                  >
                    {entry.kind === 'local'
                      ? <Folder size={14} className="text-muted group-hover:text-secondary flex-shrink-0" />
                      : <Link2 size={14} className="text-muted group-hover:text-secondary flex-shrink-0" />}
                    <span className="text-sm text-focus-blue truncate">{entry.name}</span>
                    <span className="text-xs text-muted truncate">{entry.kind === 'local' ? parentOf(entry.root) : 'Paired'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-10 pt-6">
          <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-3">Keyboard Shortcuts</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1">
            {welcome.filter(({ id }) => shortcuts[id]?.key).map(({ id, spec }) => (
              <div key={id} className="flex items-center gap-2">
                <span className="text-xs text-secondary font-mono w-10 text-right">{displayString(shortcuts[id])}</span>
                <span className="text-xs text-muted">{spec.title}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionItem({ icon, label, shortcut, onClick }: { icon: ReactNode; label: string; shortcut?: string; onClick: () => void }): JSX.Element {
  return (
    <button className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-hover transition-colors group" onClick={onClick}>
      <span className="text-muted group-hover:text-secondary">{icon}</span>
      <span className="text-sm text-focus-blue">{label}</span>
      {shortcut && <span className="ml-auto text-xs text-muted">{shortcut}</span>}
    </button>
  )
}
