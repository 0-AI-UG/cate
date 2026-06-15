// =============================================================================
// EditorConflictBanner — a non-blocking strip shown above the editor when the
// open file has diverged from disk.
//
//   kind="changed" — an external tool rewrote the file while the buffer had
//                    unsaved edits. Offers Reload (take disk), Keep mine, and
//                    View diff (disk ⇆ buffer in a Monaco diff overlay).
//   kind="deleted" — the file was removed from disk while open. The buffer is
//                    now unsaved work with no file behind it; Save to restore
//                    re-creates it, Dismiss keeps the buffer dirty so the
//                    close-confirm still protects it.
// =============================================================================

import { Warning } from '@phosphor-icons/react'

export interface EditorConflictBannerProps {
  kind: 'changed' | 'deleted'
  onReload: () => void
  onKeepMine: () => void
  onKeepBoth: () => void
  onViewDiff: () => void
  onSaveToRestore: () => void
  onDismiss: () => void
}

function BannerButton({
  onClick,
  children,
  emphasis,
}: {
  onClick: () => void
  children: string
  emphasis?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
        emphasis
          ? 'bg-warning text-white hover:opacity-90'
          : 'bg-surface-3 text-secondary hover:bg-surface-4 hover:text-primary'
      }`}
    >
      {children}
    </button>
  )
}

export default function EditorConflictBanner({
  kind,
  onReload,
  onKeepMine,
  onKeepBoth,
  onViewDiff,
  onSaveToRestore,
  onDismiss,
}: EditorConflictBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 shrink-0 px-2 py-0.5 border-b border-warning bg-warning-tint"
    >
      <Warning size={12} weight="fill" className="text-warning shrink-0" />
      <span className="text-[11px] text-primary leading-tight flex-1 min-w-0 truncate">
        {kind === 'changed'
          ? 'Changed on disk. Your unsaved edits are kept.'
          : 'Deleted on disk. Save to restore, or lose it on close.'}
      </span>
      <div className="flex items-center gap-1 shrink-0">
        {kind === 'changed' ? (
          <>
            <BannerButton onClick={onViewDiff}>View diff</BannerButton>
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
