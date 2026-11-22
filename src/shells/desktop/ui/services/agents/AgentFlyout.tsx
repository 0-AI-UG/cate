// A column of agent logos in a pill that springs open from the button it
// belongs to: the look of every "pick an agent CLI" menu.

import React from 'react'
import { agentDisplayName, type AgentId } from '@services/agents/contract'
import { MENU_ROW, POPOVER_SURFACE, Tooltip, useMenuNumbers } from '../../kernel/interaction'
import { AgentMark } from './AgentMark'

export function AgentFlyout({ agents, side, label, itemLabel, disabled = false, onPick, children, footer }: {
  agents: readonly AgentId[]
  /** The side of the button it opens on; the column grows away from it. */
  side: 'up' | 'down' | 'left' | 'right'
  label: string
  itemLabel(name: string, agentId: AgentId): string
  disabled?: boolean
  onPick(agentId: AgentId): void
  /** Shown in the pill in place of the logos (loading, nothing to pick). */
  children?: React.ReactNode
  /** An optional action alongside the available agents. */
  footer?: React.ReactNode
}): React.ReactElement {
  const down = side === 'down'
  const menuRef = React.useRef<HTMLDivElement>(null)
  useMenuNumbers(menuRef, side !== 'right')
  if (side === 'right') {
    // Inline: a row of slim buttons inside the toolbar pill that holds the button.
    return (
      <div role="menu" aria-label={label} className="cate-stagger flex items-center gap-px">
        {children ?? agents.map((agentId) => {
          const name = itemLabel(agentDisplayName(agentId), agentId)
          return (
            <Tooltip key={agentId} label={name} placement="top">
              <button
                type="button"
                role="menuitem"
                aria-label={name}
                disabled={disabled}
                onClick={() => onPick(agentId)}
                style={{ WebkitTapHighlightColor: 'transparent' }}
                className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-secondary hover:bg-hover-strong active:scale-[0.94] transition-colors duration-100 disabled:opacity-30 disabled:grayscale disabled:pointer-events-none"
              >
                <AgentMark agent={agentId} size={16} />
              </button>
            </Tooltip>
          )
        })}
        {footer}
      </div>
    )
  }
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className={`cate-spawn-flyout flex min-w-[176px] flex-col gap-0.5 p-1 ${POPOVER_SURFACE}`}
      style={{ transformOrigin: side === 'up' ? 'bottom center' : down ? 'top center' : 'bottom right' } as React.CSSProperties}
    >
      {children ?? agents.map((agentId) => {
        const name = itemLabel(agentDisplayName(agentId), agentId)
        return (
          <button
            key={agentId}
            type="button"
            role="menuitem"
            aria-label={name}
            data-menu-item
            disabled={disabled}
            onClick={() => onPick(agentId)}
            className={`${MENU_ROW} hover:bg-hover active:bg-hover-strong`}
          >
            <AgentMark agent={agentId} size={16} />
            <span className="flex-1 truncate">{agentDisplayName(agentId)}</span>
          </button>
        )
      })}
      {footer}
    </div>
  )
}
