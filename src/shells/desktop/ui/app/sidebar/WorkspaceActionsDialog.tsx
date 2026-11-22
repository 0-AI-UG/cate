// The workspace's actions as a dialog (the "⋯" on its card): invite, rename,
// settings, copy the working directory, close panels or the workspace. Arrows
// and Enter pick; a digit picks that row.

import { useState, type ReactNode } from 'react'
import { LIST_ROW_HIGHLIGHT, ListDialog } from '../../kernel/interaction'

export interface WorkspaceAction {
  id: string
  label: string
  icon: ReactNode
  /** What the row does, in a few words. */
  detail?: string
  enabled?: boolean
  /** Shown apart and in the danger colour. */
  danger?: boolean
  run(): void
}

export function WorkspaceActionsDialog({ name, location, actions, onClose }: {
  name: string
  location?: string
  actions: readonly WorkspaceAction[]
  onClose: () => void
}): JSX.Element {
  const [active, setActive] = useState(() => Math.max(0, actions.findIndex((a) => a.enabled !== false)))
  const usable = (action: WorkspaceAction | undefined): action is WorkspaceAction => !!action && action.enabled !== false
  const run = (action: WorkspaceAction | undefined): void => {
    if (!usable(action)) return
    onClose()
    action.run()
  }
  const step = (delta: number): void => {
    for (let i = 1; i <= actions.length; i++) {
      const next = (active + delta * i + actions.length * i) % actions.length
      if (usable(actions[next])) { setActive(next); return }
    }
  }
  return (
    <ListDialog
      onClose={onClose}
      ariaLabel={`${name} actions`}
      width={500}
      title={name}
      subtitle={location}
      hints={[
        { keys: ['↑', '↓'], label: 'Navigate' },
        { keys: ['Enter'], label: 'Select' },
        { keys: [`1–${actions.length}`], label: 'Pick' },
        { keys: ['Esc'], label: 'Close' },
      ]}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); step(1) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1) }
        else if (event.key === 'Enter') { event.preventDefault(); run(actions[active]) }
        else if (/^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
          event.preventDefault()
          run(actions[Number(event.key) - 1])
        }
      }}
    >
      <div role="listbox" aria-label={`${name} actions`} tabIndex={0} autoFocus className="flex min-h-0 flex-col gap-px overflow-y-auto outline-none">
        {actions.map((action, index) => {
          const enabled = usable(action)
          return (
            <button
              key={action.id}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              disabled={!enabled}
              data-active={index === active}
              onMouseMove={() => enabled && setActive(index)}
              onClick={() => run(action)}
              className={`flex min-h-7 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors disabled:opacity-40 ${
                action.danger ? 'text-danger' : 'text-primary'
              } ${index === active && enabled ? LIST_ROW_HIGHLIGHT : ''} ${action.danger && index > 0 && !actions[index - 1].danger ? 'mt-1.5' : ''}`}
            >
              <span className={`shrink-0 ${action.danger ? '' : 'text-muted'}`}>{action.icon}</span>
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.detail && <span className="max-w-[40%] shrink-0 truncate text-[12px] text-[color-mix(in_srgb,var(--text-muted)_85%,transparent)]">{action.detail}</span>}
              <span className="w-4 shrink-0 text-right text-[11px] font-medium tracking-widest text-muted">{index + 1}</span>
            </button>
          )
        })}
      </div>
    </ListDialog>
  )
}
