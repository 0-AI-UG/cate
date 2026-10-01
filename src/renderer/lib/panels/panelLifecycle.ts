import type { DockLayoutNode, PanelType } from '../../../shared/types'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { releaseCanvasStoreForPanel } from '../../stores/canvasStore'
import { captureCanvasPanel } from '../workspace/canvasAccess'
import { teardownPanelContent, type PanelRemovalReason } from './panelTeardown'

/** Tear down a panel and every panel hosted by a canvas in one deterministic
 * lifecycle. Layout removal and record storage remain host-owned. */
export function teardownPanelFamily(
  panelId: string,
  panelType: PanelType | undefined,
  reason: PanelRemovalReason,
  resolveType: (panelId: string) => PanelType | undefined,
  containerLayout?: DockLayoutNode,
): Set<string> {
  const descendants = new Set<string>()
  if (panelType === 'canvas') {
    for (const childId of captureCanvasPanel(panelId).panelIds) descendants.add(childId)
    for (const childId of descendants) {
      teardownPanelContent(childId, resolveType(childId), reason)
    }
    releaseCanvasStoreForPanel(panelId)
  }
  if (panelType === 'container') {
    for (const childId of collectPanelIds(containerLayout)) {
      descendants.add(childId)
      teardownPanelContent(childId, resolveType(childId), reason)
    }
  }
  teardownPanelContent(panelId, panelType, reason)
  return descendants
}
