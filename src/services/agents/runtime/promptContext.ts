// Prompt context from relations: what a panel's agent is told about the panels
// connected to it, compiled at the last moment so relation edits made right
// before a submit are honored by terminals and chats alike.

import { compileRelationContext, relationPanels, type RelationRoleOf } from '@workspace/relations/contract'
import type { PanelRecord, PanelRelation } from '@workspace/document/contract'
import { AGENT_DEFS, type AgentId } from '../contract'

/** `once`: sent with the next prompt, then off. `always`: every prompt. */
export type RelationContextMode = 'once' | 'always' | 'off'

/** The document as the agents service reads and writes it. */
export interface AgentsDocument {
  panel(panelId: string): PanelRecord | undefined
  panels(): Iterable<PanelRecord>
  relations(): Iterable<PanelRelation>
  /** Absolute checkout path of a worktree, if it is known. */
  worktreePath(worktreeId: string): string | undefined
  /** A panel's relation context mode; `once` when never set. */
  relationContextMode(panelId: string): RelationContextMode
  setRelationContextMode(panelId: string, mode: RelationContextMode): void
  /** The agent's own session title, shown until the user renames the panel. */
  setTitleFromAgent(panelId: string, title: string): void
  onChange(listener: () => void): () => void
}

export interface PromptContextDeps {
  document: AgentsDocument
  /** `panelRelationsEnabled`. */
  relationsEnabled(): boolean
  /** Each panel type's relation role (its definition's `relation` hook). */
  relationRole: RelationRoleOf
  /** Flushes editors connected to the panel so the agent reads what is on
   *  screen (connected editors, workspace/relations runtime). */
  flushConnected?(panelId: string): Promise<void>
}

export interface PromptContext {
  /** The armed context for the panel's next prompt, or null. */
  peek(panelId: string, agentId: AgentId | null): string | null
  /** The armed context, disarming a `once` context. Called at a real prompt
   *  submit boundary so short follow-ups do not pay for it again. */
  consume(panelId: string, agentId: AgentId | null): string | null
  /** Flush connected editors, then consume. */
  prepareForSend(panelId: string, agentId: AgentId | null): Promise<string | null>
}

export function addAgentPromptGuidance(context: string, agentId: AgentId | null): string {
  const guidance = agentId ? AGENT_DEFS[agentId].promptGuidance : null
  return guidance ? `${context}\n\n${guidance}` : context
}

export function createPromptContext(deps: PromptContextDeps): PromptContext {
  const peek = (panelId: string, agentId: AgentId | null): string | null => {
    if (!deps.relationsEnabled()) return null
    if (!deps.document.panel(panelId) || deps.document.relationContextMode(panelId) === 'off') return null
    const panels = relationPanels(deps.document.panels(), deps.relationRole)
    const context = compileRelationContext(panelId, panels, [...deps.document.relations()])?.text
    return context ? addAgentPromptGuidance(context, agentId) : null
  }
  const consume = (panelId: string, agentId: AgentId | null): string | null => {
    const context = peek(panelId, agentId)
    if (context && deps.document.relationContextMode(panelId) === 'once') {
      deps.document.setRelationContextMode(panelId, 'off')
    }
    return context
  }
  return {
    peek,
    consume,
    async prepareForSend(panelId, agentId) {
      await deps.flushConnected?.(panelId)
      return consume(panelId, agentId)
    },
  }
}
