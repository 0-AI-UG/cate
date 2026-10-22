// A column of agent logos in a pill that springs open from the button it
// belongs to: the look of every "pick an agent CLI" menu.

import React from 'react'
import { agentDisplayName, type AgentId } from '@services/agents/contract'
import { Tooltip } from '../../kernel/interaction'
import { AgentMark } from './AgentMark'

export function AgentFlyout({ agents, side, label, itemLabel, disabled = false, onPick, children }: {
  agents: readonly AgentId[]
  /** The side of the button it opens on; the column grows away from it. */
  side: 'up' | 'down' | 'left'
  label: string
  itemLabel(name: string): string
  disabled?: boolean
  onPick(agentId: AgentId): void
  /** Shown in the pill in place of the logos (loading, nothing to pick). */
  children?: React.ReactNode
}): React.ReactElement {
  const down = side === 'down'
  return (
    <div
      role="menu"
      aria-label={label}
      className={`cate-spawn-flyout flex ${down ? 'flex-col' : 'flex-col-reverse'} items-center gap-1 p-1 rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]`}
      style={{
        transformOrigin: side === 'up' ? 'bottom center' : down ? 'top center' : 'bottom right',
        ...(down ? { '--cate-flyout-dy': '-10px' } : {}),
      } as React.CSSProperties}
    >
      {children ?? agents.map((agentId, index) => {
        const name = itemLabel(agentDisplayName(agentId))
        return (
          <Tooltip key={agentId} label={name} placement={side === 'left' ? 'left' : 'right'}>
            <button
              type="button"
              role="menuitem"
              aria-label={name}
              disabled={disabled}
              onClick={() => onPick(agentId)}
              style={{ '--i': index, WebkitTapHighlightColor: 'transparent' } as React.CSSProperties}
              className="cate-spawn-flyout-item h-9 w-9 shrink-0 flex items-center justify-center rounded-full text-secondary hover:bg-hover-strong hover:scale-110 active:scale-[0.92] transition-transform duration-100 disabled:opacity-40 disabled:pointer-events-none"
            >
              <AgentMark agent={agentId} size={18} />
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
