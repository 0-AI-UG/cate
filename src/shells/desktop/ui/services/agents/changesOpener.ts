// The slot the changes pill opens through. Showing changes means review
// panels and document ops, which sit above this layer: the review panel's
// view registers the opener.

export interface AgentChangesRequest {
  workspaceId: string
  /** The terminal or chat panel whose changes to show. */
  panelId: string
}

export type AgentChangesOpener = (request: AgentChangesRequest) => boolean | Promise<boolean>

let opener: AgentChangesOpener | null = null

/** Installs the opener. Returns a function that removes it again. */
export function setAgentChangesOpener(next: AgentChangesOpener): () => void {
  opener = next
  return () => { if (opener === next) opener = null }
}

export function agentChangesOpener(): AgentChangesOpener | null {
  return opener
}
