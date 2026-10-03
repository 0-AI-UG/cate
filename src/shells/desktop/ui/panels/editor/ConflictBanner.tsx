// One header strip above the editor when the file diverged from disk. It also
// serves as the merge view's toolbar.
//   changed: the file changed on disk under unsaved edits. Reload (take disk),
//            Keep mine, Keep both (three-way merge), View/Close diff.
//   deleted: the file is gone; Save to restore re-creates it, Dismiss keeps
//            the buffer dirty so closing still asks.

import { TriangleAlert } from 'lucide-react'

export type ConflictAction = 'reload' | 'keepMine' | 'keepBoth' | 'viewDiff' | 'closeDiff' | 'saveToRestore' | 'dismiss'

function BannerButton({ onClick, children, active, emphasis }: { onClick: () => void; children: string; active?: boolean; emphasis?: boolean }) {
  const tone = emphasis
    ? 'text-warning hover:bg-warning/15'
    : active
      ? 'bg-surface-3 text-primary hover:bg-surface-4'
      : 'text-secondary hover:bg-surface-3 hover:text-primary'
  return <button onClick={onClick} className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${tone}`}>{children}</button>
}

export function ConflictBanner({ kind, showDiff, onAction }: {
  kind: 'changed' | 'deleted'
  showDiff: boolean
  onAction: (action: ConflictAction) => void
}) {
  const label = kind === 'deleted'
    ? 'Deleted on disk. Save to restore, or lose it on close.'
    : showDiff ? 'On disk vs your unsaved changes' : 'Changed on disk. Your unsaved edits are kept.'
  return (
    <div role="alert" className="flex items-center gap-2 shrink-0 px-2 py-1 border-b border-subtle" style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}>
      <TriangleAlert size={12} className="text-warning shrink-0" />
      <span className="text-[11px] text-secondary leading-tight flex-1 min-w-0 truncate">{label}</span>
      <div className="flex items-center gap-0.5 shrink-0">
        {kind === 'changed' ? (
          <>
            <BannerButton onClick={() => onAction(showDiff ? 'closeDiff' : 'viewDiff')} active={showDiff}>{showDiff ? 'Close diff' : 'View diff'}</BannerButton>
            <BannerButton onClick={() => onAction('reload')}>Reload</BannerButton>
            <BannerButton onClick={() => onAction('keepMine')}>Keep mine</BannerButton>
            <BannerButton onClick={() => onAction('keepBoth')} emphasis>Keep both</BannerButton>
          </>
        ) : (
          <>
            <BannerButton onClick={() => onAction('dismiss')}>Dismiss</BannerButton>
            <BannerButton onClick={() => onAction('saveToRestore')} emphasis>Save to restore</BannerButton>
          </>
        )}
      </div>
    </div>
  )
}
