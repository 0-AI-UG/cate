// The relation graph between panels and `compileRelationContext`, which the
// agents service uses for prompt context (architecture 9.7). Pure.

import type { JsonObject, PanelRecord, PanelRelation, RelationKind } from '@workspace/document/contract'

export type { PanelRelation } from '@workspace/document/contract'
export type PanelRelationKind = RelationKind

/** An intent offered for a relation, optionally with a pair-specific label. */
export type RelationOptionSpec = PanelRelationKind | readonly [PanelRelationKind, string]

/** How a panel type takes part in relation flows: its panel definition's
 *  `relation` hook. Generic code asks it instead of branching on the type. */
export interface RelationRole {
  /** Takes prompts (a terminal, a chat): a flow starts at it and each
   *  segment ends at the next one. */
  execution?: boolean
  /** What it hands on through a relation: an edited file, page findings or
   *  review notes. Names the relation it starts and shapes what others offer. */
  produces?: 'changes' | 'findings' | 'notes'
  /** Intents for a relation from `source` to a panel of this type, the
   *  recommended one first. Default: context, use, verify. */
  targetOptions?(source: RelationPanel): readonly RelationOptionSpec[]
  /** What an agent is told to do with this panel for a relation of `kind`,
   *  after the panel's name; undefined for the generic wording. */
  instruction?(kind: PanelRelationKind, panel: RelationPanel): string | undefined
  /** Shares its file with the agents it is connected to (connected editors). */
  sharesFile?(panel: RelationPanel): boolean
}

/** The relation role of a panel type; undefined for a type without one. */
export type RelationRoleOf = (type: string) => RelationRole | undefined

/** What the graph needs of a panel record. */
export interface RelationPanel {
  id: string
  type: string
  title: string
  fields: JsonObject
  role: RelationRole
}

export function relationPanelOf(record: PanelRecord, roleOf: RelationRoleOf): RelationPanel {
  return { id: record.id, type: record.type, title: record.title, fields: record.fields, role: roleOf(record.type) ?? {} }
}

export function relationPanels(records: Iterable<PanelRecord>, roleOf: RelationRoleOf): Record<string, RelationPanel> {
  const panels: Record<string, RelationPanel> = {}
  for (const record of records) panels[record.id] = relationPanelOf(record, roleOf)
  return panels
}

const SHORT_PANEL_ID_LEN = 8

/** The panel reference the Cate CLI shows and accepts as a unique prefix. */
export function shortPanelId(id: string): string {
  return id.length > SHORT_PANEL_ID_LEN ? id.slice(0, SHORT_PANEL_ID_LEN) : id
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
export function isExecutionSurface(panel: Pick<RelationPanel, 'role'>): boolean {
  return panel.role.execution === true
}

/** Each relation's flow, numbered from 0. A flow starts at an execution
 *  surface and stops when it reaches the next one: the incoming handoff
 *  keeps the sender's flow, relations leaving the receiver start its own.
 *  A relation no execution surface reaches has no flow. */
export function relationFlows(
  relations: readonly PanelRelation[],
  panels: Readonly<Record<string, PanelRecord>>,
  roleOf: RelationRoleOf,
): Map<string, number> {
  const takesPrompts = (record: PanelRecord) => roleOf(record.type)?.execution === true
  const outgoing = new Map<string, PanelRelation[]>()
  for (const relation of relations) {
    const connected = outgoing.get(relation.fromPanelId) ?? []
    connected.push(relation)
    outgoing.set(relation.fromPanelId, connected)
  }

  const flows = new Map<string, number>()
  let flow = 0
  for (const source of Object.values(panels)) {
    if (!takesPrompts(source) || !outgoing.has(source.id)) continue
    const queue = [source.id]
    const seenPanels = new Set<string>()
    while (queue.length > 0) {
      const panelId = queue.shift()!
      if (seenPanels.has(panelId)) continue
      seenPanels.add(panelId)
      for (const relation of outgoing.get(panelId) ?? []) {
        if (flows.has(relation.id)) continue
        flows.set(relation.id, flow)
        const target = panels[relation.toPanelId]
        if (target && !takesPrompts(target)) queue.push(target.id)
      }
    }
    flow += 1
  }
  return flows
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

const SEND_LABELS: Record<NonNullable<RelationRole['produces']>, string> = {
  changes: 'Send changes to',
  findings: 'Send findings to',
  notes: 'Send findings to',
}

function executionTargetOptions(source: RelationPanel): PanelRelationOption[] {
  if (isExecutionSurface(source)) {
    return [
      option('trigger'),
      option('context', 'Share context with'),
      option('verify', 'Ask to verify'),
    ]
  }
  return [
    option('context', source.role.produces ? SEND_LABELS[source.role.produces] : 'Send context to'),
    option('trigger', 'Continue in'),
    option('verify', 'Ask to verify'),
  ]
}

const DEFAULT_TARGET_OPTIONS: readonly RelationOptionSpec[] = ['context', 'use', 'verify']

/** Return exactly three pair-aware intents. The first is the recommendation. */
export function panelRelationOptions(source: RelationPanel, target: RelationPanel): PanelRelationOption[] {
  if (isExecutionSurface(target)) return executionTargetOptions(source)
  const specs = target.role.targetOptions?.(source) ?? DEFAULT_TARGET_OPTIONS
  return specs.map((spec) => (typeof spec === 'string' ? option(spec) : option(spec[0], spec[1])))
}

export function defaultPanelRelationKind(source: RelationPanel, target: RelationPanel): PanelRelationKind {
  return panelRelationOptions(source, target)[0].kind
}

export function panelRelationLabel(
  relation: Pick<PanelRelation, 'kind' | 'label'>,
  source?: RelationPanel,
  target?: RelationPanel,
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

function panelRef(panel: RelationPanel): string {
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
  panel: RelationPanel,
  label?: string,
  actor?: RelationPanel,
): string {
  const prefix = actor ? `${panelRef(actor)}: ` : ''
  const target = `${panelRef(panel)}${customIntent(label)}`
  const action = panel.role.instruction?.(kind, panel)
    ?? (kind === 'verify' ? 'Verify with it.' : kind === 'use' ? 'Use it.' : 'Reference it.')
  return `${prefix}${target} ${action}`
}

/** Compile the reachable flow up to the next execution surfaces, regardless
 * of the relation kind used to reach them. Sends are transport operations;
 * each destination receives its own downstream segment through the same
 * submit-time context hook as a user-entered prompt. */
export function compileRelationContext(
  sourcePanelId: string,
  panels: Record<string, RelationPanel>,
  relations: readonly PanelRelation[],
): PanelRelationContext | null {
  const source = panels[sourcePanelId]
  if (!source || !isExecutionSurface(source)) return null

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
      if (isExecutionSurface(target)) {
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
