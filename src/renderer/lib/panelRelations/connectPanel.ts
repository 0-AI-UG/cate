import {
  PANEL_RELATION_DESCRIPTIONS,
  PANEL_RELATION_LABELS,
  isPanelRelationSourceAnchored,
  panelRelationKindsForTarget,
  wouldCreatePanelRelationCycle,
  type PanelRelationKind,
} from '../../../shared/panelRelations'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'

/** Explicit, keyboard-friendly alternative to dragging a connection handle. */
export async function connectPanelToExisting(
  workspaceId: string,
  sourcePanelId: string,
): Promise<string | null> {
  if (!useSettingsStore.getState().panelRelationsEnabled) return null
  const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
  const source = workspace?.panels[sourcePanelId]
  if (!workspace || !source) return null
  if (!isPanelRelationSourceAnchored(sourcePanelId, workspace.panels, workspace.panelRelations ?? [])) {
    await window.electronAPI.showContextMenu([{
      label: 'Start this flow from an agent or terminal panel',
      enabled: false,
    }])
    return null
  }

  const targets = Object.values(workspace.panels).filter((panel) =>
    panel.id !== sourcePanelId
    && !wouldCreatePanelRelationCycle(workspace.panelRelations ?? [], sourcePanelId, panel.id),
  )
  if (targets.length === 0) {
    await window.electronAPI.showContextMenu([{ label: 'No panels available to connect', enabled: false }])
    return null
  }

  const targetChoice = await window.electronAPI.showContextMenu(targets.map((panel) => ({
    id: `target:${panel.id}`,
    label: `${panel.title} — ${panel.type}`,
  })))
  const target = targetChoice?.startsWith('target:')
    ? workspace.panels[targetChoice.slice('target:'.length)]
    : undefined
  if (!target) return null

  const kinds = panelRelationKindsForTarget(target)
  const meaningChoice = await window.electronAPI.showContextMenu(kinds.map((kind) => ({
    id: `kind:${kind}`,
    label: `${PANEL_RELATION_LABELS[kind]} — ${PANEL_RELATION_DESCRIPTIONS[kind]}`,
  })))
  if (!meaningChoice?.startsWith('kind:')) return null

  const chosenKind = meaningChoice.slice('kind:'.length) as PanelRelationKind
  return useAppStore.getState().addPanelRelation(
    workspaceId,
    sourcePanelId,
    target.id,
    chosenKind,
  )
}
