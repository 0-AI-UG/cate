// A keyboard-friendly alternative to dragging a connection handle: pick the
// target panel, then the meaning.

import type { RelationKind } from '@workspace/document/contract'
import { panelRelationOptions, relationPanelOf, wouldCreatePanelRelationCycle } from '@workspace/relations/contract'
import { addRelation } from './actions'
import { relationRoleOf, relationUiHost, relationsEnabled } from './host'
import { relationUiPort } from './port'

export async function connectPanelToExisting(workspaceId: string, sourcePanelId: string): Promise<void> {
  if (!relationsEnabled(workspaceId)) return
  const doc = relationUiHost().document(workspaceId)?.getSnapshot()
  const source = doc?.panels[sourcePanelId]
  if (!doc || !source) return
  const relations = Object.values(doc.relations)
  const targets = Object.values(doc.panels).filter((panel) =>
    panel.id !== sourcePanelId && !wouldCreatePanelRelationCycle(relations, sourcePanelId, panel.id))
  const menu = relationUiPort().showMenu
  if (targets.length === 0) {
    await menu([{ label: 'No panels available to connect', enabled: false }])
    return
  }

  const targetChoice = await menu(targets.map((panel) => ({ id: `target:${panel.id}`, label: `${panel.title}: ${panel.type}` })))
  const target = targetChoice?.startsWith('target:') ? doc.panels[targetChoice.slice('target:'.length)] : undefined
  if (!target) return

  const options = panelRelationOptions(relationPanelOf(source, relationRoleOf), relationPanelOf(target, relationRoleOf))
  const meaningChoice = await menu(options.map((option, index) => ({
    id: `kind:${option.kind}`,
    label: `${option.label}: ${option.description}${index === 0 ? ' · Recommended' : ''}`,
  })))
  if (!meaningChoice?.startsWith('kind:')) return
  addRelation(workspaceId, sourcePanelId, target.id, meaningChoice.slice('kind:'.length) as RelationKind)
}
