// What the relation UI needs from other modules, installed by the client
// shell: a native menu, the agent transport of an execution panel, and an
// unsaved text panel for previews. Inert defaults keep it renderable.

import type { PanelRecord } from '@workspace/document/contract'

export type RelationMenuItem =
  | { type: 'separator' }
  | { type?: undefined; id?: string; label: string; enabled?: boolean }

export interface RelationContextTransport {
  /** Adds the agent's prompt guidance to the compiled context. */
  decorate(text: string): string
  /** When context last went with the panel's prompt (epoch ms). */
  sentAt?: number
}

export interface RelationUiPort {
  /** A context menu at the pointer; resolves the picked id. */
  showMenu(items: RelationMenuItem[]): Promise<string | null>
  /** React hook: how the panel's running agent takes relation context, or
   *  null when it has no prompt context hook (the toggle then hides). */
  useContextTransport(workspaceId: string, panel: PanelRecord): RelationContextTransport | null
  openTextPreview(request: { workspaceId: string; sourcePanelId: string; title: string; content: string }): Promise<unknown>
}

const PASS_THROUGH: RelationContextTransport = { decorate: (text) => text }

const DEFAULT_PORT: RelationUiPort = {
  showMenu: async () => null,
  useContextTransport: () => PASS_THROUGH,
  openTextPreview: async () => null,
}

let port: RelationUiPort = DEFAULT_PORT

export function installRelationUiPort(next: Partial<RelationUiPort> | null): void {
  port = next ? { ...DEFAULT_PORT, ...next } : DEFAULT_PORT
}

export function relationUiPort(): RelationUiPort {
  return port
}
