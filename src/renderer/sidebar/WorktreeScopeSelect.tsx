import React from 'react'
import { GitBranch } from '@phosphor-icons/react'
import type { JoinedWorktree } from '../stores/useWorktrees'

function label(worktree: JoinedWorktree): string {
  return worktree.label || worktree.branch || (worktree.isPrimary ? 'main' : '(detached)')
}

export const WorktreeScopeSelect: React.FC<{
  worktrees: JoinedWorktree[]
  value?: string
  onChange: (worktreeId: string) => void
  prefix?: string
  title: string
}> = ({ worktrees, value, onChange, prefix, title }) => {
  const live = worktrees.filter((worktree) => !worktree.isOrphan)
  if (live.length < 2) return null
  const selected = live.find((worktree) => worktree.id === value)
    ?? live.find((worktree) => worktree.isPrimary)
    ?? live[0]

  return (
    <label className="inline-flex max-w-full items-center gap-1 text-[11px] text-muted" title={title}>
      <GitBranch size={11} className="flex-shrink-0" />
      {prefix && <span className="flex-shrink-0">{prefix}</span>}
      <select
        aria-label={title}
        value={selected.id}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 max-w-full truncate bg-transparent text-secondary outline-none cursor-pointer"
      >
        {live.map((worktree) => (
          <option key={worktree.id} value={worktree.id}>{label(worktree)}</option>
        ))}
      </select>
    </label>
  )
}
