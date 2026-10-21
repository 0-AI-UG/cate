// The agents a new terminal can start as: the logos of the agent CLIs whose
// Cate hooks are on here (on, or auto and in use), in a column that pops up
// over the new-terminal button. A pick starts that agent instead of a shell.

import React, { useEffect, useState } from 'react'
import type { AgentId, AgentTypeInfo } from '@services/agents/contract'
import { useRuntime } from '../../kernel/rpc'
import { AgentFlyout } from './AgentFlyout'

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
    <AgentFlyout
      agents={ready.map((type) => type.agentId)}
      side={side}
      label="Start an agent"
      itemLabel={(name) => `New ${name}`}
      onPick={onPick}
    />
  )
}
