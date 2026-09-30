// Target resolution (architecture 14): an explicit id, then the caller's
// sticky target, then the caller's placement group, then the active panel of
// the most recently active client, then the only panel of the type. A
// method's target policy says how far down that list it may go.

import { RpcError } from '@kernel/rpc/contract'
import type { ApiCaller, ApiStickyTarget, TargetPolicy } from '../contract'

export interface ApiPanelInfo {
  id: string
  type: string
  placementGroupId?: string
}

/** What the router reads from the document. */
export interface ApiDocumentReader {
  panel(id: string): ApiPanelInfo | undefined
  panels(): Iterable<ApiPanelInfo>
}

/** What the router reads from presence. */
export interface ApiPresenceReader {
  /** The panel the most recently active client has active, if any. */
  activePanelId(): string | undefined
}

const SHORT_ID = 8
const short = (id: string): string => (id.length > SHORT_ID ? id.slice(0, SHORT_ID) : id)

/**
 * Resolves a full id or a unique id prefix to a panel. With `type`, only
 * panels of that type match a prefix, and an exact id of another type is
 * rejected.
 */
export function resolvePanelRef(document: ApiDocumentReader, ref: string, type?: string): ApiPanelInfo {
  const exact = document.panel(ref)
  if (exact) {
    if (type && exact.type !== type) throw new RpcError('rejected', `panel-is-${exact.type}-not-${type}`)
    return exact
  }
  const matches: ApiPanelInfo[] = []
  for (const candidate of document.panels()) {
    if (type && candidate.type !== type) continue
    if (candidate.id.startsWith(ref)) matches.push(candidate)
  }
  if (matches.length === 1) return matches[0]
  const label = type ? `${type} panel` : 'panel'
  if (matches.length === 0) throw new RpcError('gone', `no ${label} matching '${ref}'`)
  throw new RpcError('rejected', `ambiguous ${label} '${ref}' matches ${matches.map((p) => short(p.id)).join(', ')}`)
}

export interface TargetQuery {
  type: string
  policy: TargetPolicy
  explicit?: string
  caller: ApiCaller
  sticky: ApiStickyTarget
  document: ApiDocumentReader
  presence: ApiPresenceReader
}

export function resolveTarget(query: TargetQuery): string {
  const { type, policy, document } = query
  if (query.explicit !== undefined) return resolvePanelRef(document, query.explicit, type).id

  const stickyId = query.sticky.get()
  if (stickyId !== undefined) {
    const selected = document.panel(stickyId)
    if (!selected) {
      query.sticky.clear()
    } else if (selected.type !== type) {
      throw new RpcError('rejected', `selected-panel-is-${selected.type}-not-${type}`)
    } else {
      return selected.id
    }
  }
  if (policy !== 'auto') {
    throw new RpcError(
      'rejected',
      `${type}-target-required: pass --panel <id> or select one with cate panel set <id>`,
    )
  }

  const ofType = [...document.panels()].filter((p) => p.type === type)
  const group = query.caller.placementGroupId
  if (group) {
    const grouped = ofType.filter((p) => p.placementGroupId === group)
    if (grouped.length === 1) return grouped[0].id
    if (grouped.length > 1) throw new RpcError('rejected', `${type}-target-required: several ${type} panels, pass --panel <id>`)
  }

  const activeId = query.presence.activePanelId()
  const active = activeId ? document.panel(activeId) : undefined
  if (active?.type === type) return active.id

  if (ofType.length === 1) return ofType[0].id
  if (ofType.length === 0) throw new RpcError('rejected', `no-${type}: no ${type} panel is open`)
  throw new RpcError('rejected', `${type}-target-required: several ${type} panels, pass --panel <id>`)
}
