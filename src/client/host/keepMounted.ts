// Which panels are exempt from the canvas viewport cull: views with a native
// surface lose their page when unmounted, so their nodes stay mounted
// off-screen. The cull caches on set identity and re-runs on every pan frame,
// so the set keeps its identity while its membership is unchanged.

import type { WorkspaceDocument } from '@workspace/document/contract'
import { keepsMounted } from './definitions'

export function keepMountedPanelIds(doc: WorkspaceDocument): Set<string> {
  const ids = new Set<string>()
  for (const record of Object.values(doc.panels)) if (keepsMounted(record.type)) ids.add(record.id)
  return ids
}

export function setEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

