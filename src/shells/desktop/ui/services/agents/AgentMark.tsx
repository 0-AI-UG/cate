// An agent's logo at a given size: how every view shows which CLI it means.

import type { AgentId } from '@services/agents/contract'
import { agentLogo } from './logos'

export function AgentMark({ agent, size }: { agent: AgentId; size: number }) {
  const logo = agentLogo(agent)
  if (!logo) return null
  return <img src={logo} alt="" aria-hidden draggable={false} width={size} height={size} className="shrink-0" style={{ width: size, height: size, objectFit: 'contain' }} />
}
