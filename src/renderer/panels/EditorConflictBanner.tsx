// =============================================================================
// EditorConflictBanner — a single, minimal header strip shown above the editor
// when the open file has diverged from disk. It doubles as the diff toolbar:
// while the disk ⇆ buffer diff overlay is open it stays put (no second bar),
// just swapping its label and offering "Close diff".
//
//   kind="changed" — an external tool rewrote the file while the buffer had
//                    unsaved edits. Offers Reload (take disk), Keep mine,
//                    Keep both, and View/Close diff (disk ⇆ buffer overlay).
//   kind="deleted" — the file was removed from disk while open. The buffer is
//                    now unsaved work with no file behind it; Save to restore
//                    re-creates it, Dismiss keeps the buffer dirty so the
//                    close-confirm still protects it.
// =============================================================================

import { Warning } from '@phosphor-icons/react'

export interface EditorConflictBannerProps {
  kind: 'changed' | 'deleted'
  showDiff: boolean
  onReload: () => void
  onKeepMine: () => void
  onKeepBoth: () => void
  onViewDiff: () => void
  onCloseDiff: () => void
  onSaveToRestore: () => void
  onDismiss: () => void
}

function BannerButton({
  onClick,
  children,
  active,
  emphasis,
}: {
  onClick: () => void
  children: string
  active?: boolean
  emphasis?: boolean
}) {
  const tone = emphasis
    ? 'text-warning hover:bg-warning/15'
    : active
      ? 'bg-surface-3 text-primary hover:bg-surface-4'
      : 'text-secondary hover:bg-surface-3 hover:text-primary'
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${tone}`}
    >
      {children}
    </button>
  )
}

export default function EditorConflictBanner({
  kind,
  showDiff,
  onReload,
  onKeepMine,
  onKeepBoth,
  onViewDiff,
  onCloseDiff,
  onSaveToRestore,
  onDismiss,
}: EditorConflictBannerProps) {
  const label =
    kind === 'deleted'
      ? 'Deleted on disk. Save to restore, or lose it on close.'
      : showDiff
        ? 'On disk vs your unsaved changes'
        : 'Changed on disk. Your unsaved edits are kept.'

  return (
    <div
      role="alert"
      className="flex items-center gap-2 shrink-0 px-2 py-1 border-b border-subtle"
      style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}
    >
      <Warning size={12} weight="fill" className="text-warning shrink-0" />
      <span className="text-[11px] text-secondary leading-tight flex-1 min-w-0 truncate">
        {label}
      </span>
      <div className="flex items-center gap-0.5 shrink-0">
        {kind === 'changed' ? (
          <>
            <BannerButton
              onClick={showDiff ? onCloseDiff : onViewDiff}
              active={showDiff}
            >
              {showDiff ? 'Close diff' : 'View diff'}
            </BannerButton>
            <BannerButton onClick={onReload}>Reload</BannerButton>
            <BannerButton onClick={onKeepMine}>Keep mine</BannerButton>
            <BannerButton onClick={onKeepBoth} emphasis>Keep both</BannerButton>
          </>
        ) : (
          <>
            <BannerButton onClick={onDismiss}>Dismiss</BannerButton>
            <BannerButton onClick={onSaveToRestore} emphasis>Save to restore</BannerButton>
          </>
        )}
      </div>
    </div>
  )
}
