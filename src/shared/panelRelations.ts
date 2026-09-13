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

export interface PanelRelationOption {
  kind: PanelRelationKind
  label: string
  description: string
}

/** A panel transport that can receive a prompt. The provider running through
 * it (Codex, Claude, etc.) is resolved separately at submission time. */
export function isExecutionSurface(type: PanelType): boolean {
  return type === 'terminal' || type === 'agent'
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

function option(kind: PanelRelationKind, label = PANEL_RELATION_LABELS[kind]): PanelRelationOption {
  return { kind, label, description: PANEL_RELATION_DESCRIPTIONS[kind] }
}

function executionTargetOptions(source: PanelState): PanelRelationOption[] {
  if (isExecutionSurface(source.type)) {
    return [
      option('trigger'),
      option('context', 'Share context with'),
      option('verify', 'Ask to verify'),
    ]
  }
  const contextLabel = source.type === 'editor'
    ? 'Send changes to'
    : source.type === 'browser' || source.type === 'review'
      ? 'Send findings to'
      : 'Send context to'
  return [
    option('context', contextLabel),
    option('trigger', 'Continue in'),
    option('verify', 'Ask to verify'),
  ]
}

/** Return exactly three pair-aware intents. The first is the recommendation. */
export function panelRelationOptions(source: PanelState, target: PanelState): PanelRelationOption[] {
  if (isExecutionSurface(target.type)) return executionTargetOptions(source)
  if (target.type === 'browser') {
    if (isExecutionSurface(source.type)) return [option('use'), option('verify'), option('context')]
    if (source.type === 'editor' || source.type === 'review') {
      return [option('verify', 'Verify in'), option('use'), option('context')]
    }
    return [option('context'), option('verify'), option('use')]
  }
  if (target.type === 'editor') {
    if (isExecutionSurface(source.type)) return [option('use'), option('context'), option('verify')]
    if (source.type === 'review') return [option('use', 'Address in'), option('context'), option('verify')]
    return [option('context'), option('use'), option('verify')]
  }
  if (target.type === 'review') {
    return source.type === 'review'
      ? [option('context'), option('verify'), option('use')]
      : [option('verify'), option('context'), option('use')]
  }
  return [option('context'), option('use'), option('verify')]
}

export function defaultPanelRelationKind(source: PanelState, target: PanelState): PanelRelationKind {
  return panelRelationOptions(source, target)[0].kind
}

export function panelRelationLabel(
  relation: Pick<PanelRelation, 'kind' | 'label'>,
  source?: PanelState,
  target?: PanelState,
): string {
  const customLabel = relation.label?.trim()
  if (customLabel) return customLabel
  return source && target
    ? panelRelationOptions(source, target).find((candidate) => candidate.kind === relation.kind)?.label
      ?? PANEL_RELATION_LABELS[relation.kind]
    : PANEL_RELATION_LABELS[relation.kind]
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
    const action = kind === 'verify'
      ? 'Verify with it'
      : kind === 'context' ? 'Use it as supporting context' : 'Use it'
    return `${prefix}${target} ${action} through Cate browser automation; don't open another browser.`
  }
  if (panel.type === 'editor' && panel.filePath) {
    return kind === 'use'
      ? `${prefix}${target} Work in ${panel.filePath}.`
      : kind === 'verify'
        ? `${prefix}${target} Verify against ${panel.filePath}.`
      : `${prefix}${target} Reference ${panel.filePath}.`
  }
  if (panel.type === 'review') {
    const action = kind === 'verify' ? 'Verify with it' : kind === 'use' ? 'Work through it' : 'Reference it'
    return `${prefix}${target} ${action} through Cate review commands.`
  }
  if (panel.type === 'canvas') {
    const action = kind === 'verify' ? 'Verify using its panels' : kind === 'use' ? 'Work through its panels' : 'Reference its panels'
    return `${prefix}${target} ${action} when relevant.`
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
        const instruction = relation.kind === 'context'
          ? 'Send relevant context by running'
          : relation.kind === 'verify' ? 'Ask it to verify by running' : 'When ready, run'
        const task = relation.kind === 'context'
          ? '<relevant context and how to use it>'
          : relation.kind === 'verify' ? '<result to verify and relevant findings>' : '<task and relevant findings>'
        instructions.push(
          `${actorId === sourcePanelId ? '' : `${panelRef(actor)}: `}`
          + `${panelRef(target)}${customIntent(relation.label)} ${instruction} `
          + `cate agent send --panel ${shortPanelId(target.id)} "${task}".`,
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
