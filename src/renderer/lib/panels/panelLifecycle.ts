import type { PanelType } from '../../../shared/types'
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
): Set<string> {
  const descendants = new Set<string>()
  if (panelType === 'canvas') {
    for (const childId of captureCanvasPanel(panelId).panelIds) descendants.add(childId)
    for (const childId of descendants) {
      teardownPanelContent(childId, resolveType(childId), reason)
    }
    releaseCanvasStoreForPanel(panelId)
  }
  teardownPanelContent(panelId, panelType, reason)
  return descendants
}
