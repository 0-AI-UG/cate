// The agents a new terminal can start as: the logos of the agent CLIs whose
// Cate hooks are on here (on, or auto and in use), in a column that pops up
// over the new-terminal button. A pick starts that agent instead of a shell.

import React, { useEffect } from 'react'
import { LoaderCircle, Settings2 } from 'lucide-react'
import { clientUi } from '@kernel/interaction'
import type { AgentId } from '@services/agents/contract'
import { useRuntime } from '../../kernel/rpc'
import { useAgentAvailability } from './useAgentAvailability'
import { AgentFlyout } from './AgentFlyout'

export function AgentSpawnFlyout({ workspaceId, side, onPick, onShown }: {
  workspaceId: string
  /** The side of the button it opens on; the column grows away from it. */
  side: 'up' | 'left'
  onPick(agentId: AgentId): void
  onShown(shown: boolean): void
}): React.ReactElement | null {
  const runtime = useRuntime(workspaceId)
  const availability = useAgentAvailability(workspaceId)
  const types = availability?.types ?? []
  const ready = types.filter((type) => type.ready)
  const shown = runtime !== null
  useEffect(() => { onShown(shown) }, [shown, onShown])
  if (!shown) return null

  return (
    <AgentFlyout
      agents={ready.map((type) => type.agentId)}
      side={side}
      label="Start an agent"
      itemLabel={(name) => `New ${name}`}
      onPick={onPick}
      children={!availability?.snapshot ? <span role="status" aria-label={availability?.error ?? 'Checking agents'} title={availability?.error ?? 'Checking agents'} className="h-9 w-9 flex items-center justify-center text-muted"><LoaderCircle size={17} className={availability?.error ? '' : 'animate-spin'} /></span> : undefined}
      footer={<button type="button" role="menuitem" aria-label="Set up AI agents" title="Install or sign in to agent CLIs" onClick={() => clientUi().openSettings('agents')} className="h-9 w-9 shrink-0 flex items-center justify-center rounded-full text-muted hover:bg-hover-strong hover:text-primary"><Settings2 size={17} /></button>}
    />
  )
}
