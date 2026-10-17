// The agents a new terminal can start as: the logos of the agent CLIs whose
// Cate hooks are on here (on, or auto and in use), in a column that pops up
// over the new-terminal button. A pick starts that agent instead of a shell.

import React, { useEffect, useState } from 'react'
import type { AgentId, AgentTypeInfo } from '@services/agents/contract'
import { Tooltip } from '../../kernel/interaction'
import { useRuntime } from '../../kernel/rpc'
import { agentLogo } from './logos'

/** The last answer per workspace: the first inspection can take seconds, so
 *  the column shows the known agents while it refreshes. */
const known = new Map<string, AgentTypeInfo[]>()

export function AgentSpawnFlyout({ workspaceId, side, onPick, onShown }: {
  workspaceId: string
  /** The side of the button it opens on; the column grows away from it. */
  side: 'up' | 'left'
  onPick(agentId: AgentId): void
  onShown(shown: boolean): void
}): React.ReactElement | null {
  const runtime = useRuntime(workspaceId)
  const [types, setTypes] = useState(() => known.get(workspaceId) ?? [])
  useEffect(() => {
    if (!runtime) return
    let live = true
    runtime.agents.types().then((list) => {
      known.set(workspaceId, list)
      if (live) setTypes(list)
    }, () => {})
    return () => { live = false }
  }, [runtime, workspaceId])

  const ready = types.filter((type) => type.ready)
  const shown = ready.length > 0
  useEffect(() => { onShown(shown) }, [shown, onShown])
  if (!shown) return null

  return (
    <div
      role="menu"
      aria-label="Start an agent"
      className="cate-spawn-flyout flex flex-col-reverse items-center gap-1 p-1 rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]"
      style={{ transformOrigin: side === 'up' ? 'bottom center' : 'bottom right' }}
    >
      {ready.map((type, index) => (
        <Tooltip key={type.agentId} label={`New ${type.displayName}`} placement={side === 'up' ? 'right' : 'left'}>
          <button
            type="button"
            role="menuitem"
            aria-label={`New ${type.displayName}`}
            onClick={() => onPick(type.agentId)}
            style={{ '--i': index, WebkitTapHighlightColor: 'transparent' } as React.CSSProperties}
            className="cate-spawn-flyout-item h-9 w-9 shrink-0 flex items-center justify-center rounded-full text-secondary hover:bg-hover-strong hover:scale-110 active:scale-[0.92] transition-transform duration-100"
          >
            <img src={agentLogo(type.agentId) ?? undefined} alt="" width={18} height={18} draggable={false} style={{ width: 18, height: 18, objectFit: 'contain' }} />
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
