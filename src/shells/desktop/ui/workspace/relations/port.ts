// What the relation UI needs from other modules, installed by the client
// shell: a native menu, the agent transport of an execution panel, and an
// unsaved text panel for previews. Inert defaults keep it renderable.

import type { PanelRecord } from '@workspace/document/contract'

export type RelationMenuItem =
  | { type: 'separator' }
  | { type?: undefined; id?: string; label: string; enabled?: boolean }

export interface RelationContextTransport {
  /** When context last went with the panel's prompt (epoch ms). */
  sentAt?: number
  /** Context cannot reach the agent: a short label and why. */
  blocked?: { label: string; reason: string }
}

export interface RelationUiPort {
  /** A context menu at the pointer; resolves the picked id. */
  showMenu(items: RelationMenuItem[]): Promise<string | null>
  /** React hook: how the panel's running agent takes relation context, or
   *  null when no agent runs there (the toggle then hides). */
  useContextTransport(workspaceId: string, panel: PanelRecord): RelationContextTransport | null
  /** The context the panel's next prompt would take, exactly as sent. */
  previewContext(workspaceId: string, panelId: string): Promise<string | null>
  openTextPreview(request: { workspaceId: string; sourcePanelId: string; title: string; content: string }): Promise<unknown>
}

const PASS_THROUGH: RelationContextTransport = {}

const DEFAULT_PORT: RelationUiPort = {
  showMenu: async () => null,
  useContextTransport: () => PASS_THROUGH,
  previewContext: async () => null,
  openTextPreview: async () => null,
}

let port: RelationUiPort = DEFAULT_PORT

export function installRelationUiPort(next: Partial<RelationUiPort> | null): void {
  port = next ? { ...DEFAULT_PORT, ...next } : DEFAULT_PORT
}

export function relationUiPort(): RelationUiPort {
  return port
}
