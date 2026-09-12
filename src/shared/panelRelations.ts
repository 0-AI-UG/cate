import type { PanelState, PanelType, Point } from './types'
import { shortPanelId } from './panelIds'

export type PanelRelationKind = 'use' | 'context' | 'verify' | 'trigger'
export type PanelConnectionSide = 'top' | 'right' | 'bottom' | 'left'

export interface PanelRelation {
  id: string
  fromPanelId: string
  toPanelId: string
  kind: PanelRelationKind
  /** User-authored wording shown on the canvas. The relation kind remains the
   * routing fallback so older consumers and saved sessions stay compatible. */
  label?: string
  fromSide?: PanelConnectionSide
  toSide?: PanelConnectionSide
  /** Canvas-space point that the rendered curve passes through at its midpoint. */
  waypoint?: Point
}

export interface PanelRelationContext {
  text: string
  targetExecutionPanelIds: string[]
  relatedPanelIds: string[]
}

/** A panel transport that can receive a prompt. The provider running through
 * it (Codex, Claude, etc.) is resolved separately at submission time. */
export function isExecutionSurface(type: PanelType): boolean {
  return type === 'terminal' || type === 'agent'
}

export function defaultPanelRelationKind(target: PanelState): PanelRelationKind {
  if (isExecutionSurface(target.type)) return 'trigger'
  if (target.type === 'browser') return 'use'
  if (target.type === 'review') return 'verify'
  return 'context'
}

export const PANEL_RELATION_LABELS: Record<PanelRelationKind, string> = {
  use: 'Work in',
  context: 'Reference',
  verify: 'Verify',
  trigger: 'Hand off',
}

export const PANEL_RELATION_DESCRIPTIONS: Record<PanelRelationKind, string> = {
  use: 'Act through this panel',
  context: 'Read as supporting context',
  verify: 'Validate the result',
  trigger: 'Send the next task',
}

export function panelRelationLabel(relation: Pick<PanelRelation, 'kind' | 'label'>): string {
  return relation.label?.trim() || PANEL_RELATION_LABELS[relation.kind]
}

/** Only offer intents that make sense for the destination. Recommended first. */
export function panelRelationKindsForTarget(target: PanelState): PanelRelationKind[] {
  if (isExecutionSurface(target.type)) return ['trigger']
  if (target.type === 'browser') return ['use', 'verify', 'context']
  if (target.type === 'editor') return ['context', 'use']
  if (target.type === 'review') return ['verify', 'context']
  return ['context']
}

export function wouldCreatePanelRelationCycle(
  relations: readonly PanelRelation[],
  fromPanelId: string,
  toPanelId: string,
): boolean {
  if (fromPanelId === toPanelId) return true
  const outgoing = new Map<string, string[]>()
  for (const relation of relations) {
    const targets = outgoing.get(relation.fromPanelId) ?? []
    targets.push(relation.toPanelId)
    outgoing.set(relation.fromPanelId, targets)
  }
  const queue = [toPanelId]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === fromPanelId) return true
    if (seen.has(current)) continue
    seen.add(current)
    queue.push(...(outgoing.get(current) ?? []))
  }
  return false
}

/** A relation only affects prompts when its source is an execution surface or
 * already belongs to a flow rooted at one. */
export function isPanelRelationSourceAnchored(
  panelId: string,
  panels: Record<string, PanelState>,
  relations: readonly PanelRelation[],
): boolean {
  const reachable = new Set(Object.values(panels)
    .filter((panel) => isExecutionSurface(panel.type))
    .map((panel) => panel.id))
  const queue = [...reachable]
  while (queue.length > 0) {
    const sourceId = queue.shift()!
    for (const relation of relations) {
      if (relation.fromPanelId !== sourceId || reachable.has(relation.toPanelId)) continue
      reachable.add(relation.toPanelId)
      queue.push(relation.toPanelId)
    }
  }
  return reachable.has(panelId)
}


function panelRef(panel: PanelState): string {
  const id = shortPanelId(panel.id)
  return panel.title === panel.id ? `${panel.type} ${id}` : `${panel.title} ${id}`
}

function customIntent(label?: string): string {
  const text = label?.trim()
  if (!text) return ''
  return ` — ${text}${/[.!?]$/.test(text) ? '' : '.'}`
}

function resourceInstruction(
  kind: PanelRelationKind,
  panel: PanelState,
  label?: string,
  actor?: PanelState,
): string {
  const prefix = actor ? `${panelRef(actor)}: ` : ''
  const target = `${panelRef(panel)}${customIntent(label)}`
  if (panel.type === 'browser') {
    return kind === 'verify'
      ? `${prefix}${target} Verify with it through Cate browser automation; don't open another browser.`
      : `${prefix}${target} Use it through Cate browser automation; don't open another browser.`
  }
  if (panel.type === 'editor' && panel.filePath) {
    return kind === 'use'
      ? `${prefix}${target} Work in ${panel.filePath}.`
      : `${prefix}${target} Reference ${panel.filePath}.`
  }
  if (panel.type === 'review') {
    return `${prefix}${target} Verify with it through Cate review commands.`
  }
  if (panel.type === 'canvas') {
    return `${prefix}${target} Reference its panels when relevant.`
  }
  const action = kind === 'verify' ? 'Verify with it.' : kind === 'use' ? 'Use it.' : 'Reference it.'
  return `${prefix}${target} ${action}`
}

/** Compile the reachable flow up to the next execution surfaces, regardless
 * of the relation kind used to reach them. Sends are transport operations;
 * each destination receives its own downstream segment through the same
 * submit-time context hook as a user-entered prompt. */
export function compilePanelRelationContext(
  sourcePanelId: string,
  panels: Record<string, PanelState>,
  relations: readonly PanelRelation[],
): PanelRelationContext | null {
  const source = panels[sourcePanelId]
  if (!source || !isExecutionSurface(source.type)) return null

  const outgoing = new Map<string, PanelRelation[]>()
  for (const relation of relations) {
    if (!panels[relation.fromPanelId] || !panels[relation.toPanelId]) continue
    const list = outgoing.get(relation.fromPanelId) ?? []
    list.push(relation)
    outgoing.set(relation.fromPanelId, list)
  }

  const instructions: string[] = []
  const targetExecutionPanelIds: string[] = []
  const relatedPanelIds: string[] = []
  const seenRelations = new Set<string>()
  const queue = [{ panelId: sourcePanelId, actorId: sourcePanelId }]
  while (queue.length > 0) {
    const { panelId: fromId, actorId } = queue.shift()!
    const actor = panels[actorId]
    for (const relation of outgoing.get(fromId) ?? []) {
      if (seenRelations.has(relation.id)) continue
      seenRelations.add(relation.id)
      const target = panels[relation.toPanelId]
      if (!target) continue
      if (!relatedPanelIds.includes(target.id)) relatedPanelIds.push(target.id)
      if (isExecutionSurface(target.type)) {
        if (!targetExecutionPanelIds.includes(target.id)) targetExecutionPanelIds.push(target.id)
        instructions.push(
          `${actorId === sourcePanelId ? '' : `${panelRef(actor)}: `}`
          + `${panelRef(target)}${customIntent(relation.label)} When ready, run `
          + `cate agent send --panel ${shortPanelId(target.id)} "<task and relevant findings>".`,
        )
        continue
      }
      instructions.push(resourceInstruction(
        relation.kind,
        target,
        relation.label,
        actorId === sourcePanelId ? undefined : actor,
      ))
      queue.push({ panelId: target.id, actorId })
    }
  }

  if (instructions.length === 0) return null
  return {
    targetExecutionPanelIds,
    relatedPanelIds,
    text: [
      '<cate-connected-panels>',
      'Routing context:',
      ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
      '</cate-connected-panels>',
    ].join('\n'),
  }
}
