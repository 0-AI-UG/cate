// Prompt context from relations: what a panel's agent is told about the panels
// connected to it, compiled at the last moment so relation edits made right
// before a submit are honored.

import { compileRelationContext, relationContextMode, relationPanels, type RelationContextMode, type RelationRoleOf } from '@workspace/relations/contract'
import type { PanelRecord, PanelRelation } from '@workspace/document/contract'
import { AGENT_DEFS, type AgentId } from '../contract'

/** The document as the agents service reads and writes it. */
export interface AgentsDocument {
  panel(panelId: string): PanelRecord | undefined
  panels(): Iterable<PanelRecord>
  relations(): Iterable<PanelRelation>
  /** Absolute checkout path of a worktree, if it is known. */
  worktreePath(worktreeId: string): string | undefined
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
  /** A conversation boundary invalidates automatic delivery, not the user policy. */
  reset(panelId: string): void
  /** Flush connected editors so the agent reads what is on screen. */
  flush(panelId: string): Promise<void>
  /** When context last went with the panel's prompt (epoch ms). */
  sentAt(panelId: string): number | undefined
  onSent(listener: (panelId: string) => void): () => void
}

export function addAgentPromptGuidance(context: string, agentId: AgentId | null): string {
  const guidance = agentId ? AGENT_DEFS[agentId].promptGuidance : null
  return guidance ? `${context}\n\n${guidance}` : context
}

export function createPromptContext(deps: PromptContextDeps): PromptContext {
  const delivered = new Map<string, string>()
  const peek = (panelId: string, agentId: AgentId | null): string | null => {
    if (!deps.relationsEnabled()) return null
    const record = deps.document.panel(panelId)
    if (!record || relationContextMode(record.fields) === 'off') return null
    const panels = relationPanels(deps.document.panels(), deps.relationRole)
    const relations = [...deps.document.relations()].sort((a, b) => a.id.localeCompare(b.id))
    const compiled = compileRelationContext(panelId, panels, relations)?.text
    // Removing the last connection also invalidates previously sent routing.
    const context = compiled ?? (delivered.has(panelId)
      ? '<cate-connected-panels>\nNo connected panels remain. Previous routing instructions no longer apply.\n</cate-connected-panels>'
      : null)
    if (!context) return null
    const text = addAgentPromptGuidance(context, agentId)
    return relationContextMode(record.fields) === 'auto' && delivered.get(panelId) === text ? null : text
  }
  const sent = new Map<string, number>()
  const sentListeners = new Set<(panelId: string) => void>()
  const consume = (panelId: string, agentId: AgentId | null): string | null => {
    const context = peek(panelId, agentId)
    if (!context) return null
    delivered.set(panelId, context)
    const record = deps.document.panel(panelId)
    if (record && relationContextMode(record.fields) === 'once') {
      deps.document.setRelationContextMode(panelId, 'off')
    }
    sent.set(panelId, Date.now())
    for (const listener of [...sentListeners]) listener(panelId)
    return context
  }
  return {
    peek,
    consume,
    reset: (panelId) => { delivered.delete(panelId); sent.delete(panelId) },
    sentAt: (panelId) => sent.get(panelId),
    onSent(listener) {
      sentListeners.add(listener)
      return () => { sentListeners.delete(listener) }
    },
    async flush(panelId) {
      await deps.flushConnected?.(panelId)
    },
  }
}
