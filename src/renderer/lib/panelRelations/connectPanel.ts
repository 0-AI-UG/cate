import {
  panelRelationOptions,
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

  const options = panelRelationOptions(source, target)
  const meaningChoice = await window.electronAPI.showContextMenu(options.map((option, index) => ({
    id: `kind:${option.kind}`,
    label: `${option.label} — ${option.description}${index === 0 ? ' · Recommended' : ''}`,
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
