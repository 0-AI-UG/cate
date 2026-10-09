// Shape checks for values that cross the wire or come from disk. Each returns
// null when the value is well formed, or what is wrong with it.

import { isFiniteRect, type Point, type Rect } from '@workspace/canvas/contract'
import type { DockNode } from './dock'
import type { DocChange, PanelPatch, PlaceTarget, RelationPatch } from './ops'
import {
  isPanelType,
  RELATION_KINDS,
  RELATION_SIDES,
  WORKTREE_STATUSES,
  type Json,
} from './schema'

type Problem = string | null

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function isPoint(v: unknown): v is Point {
  return isObject(v) && Number.isFinite(v.x) && Number.isFinite(v.y)
}

/** A finite rect with a positive size. */
export function isRect(v: unknown): v is Rect {
  if (!isObject(v) || !isObject(v.origin) || !isObject(v.size)) return false
  const r = v as unknown as Rect
  return typeof r.origin.x === 'number' && typeof r.origin.y === 'number'
    && typeof r.size.width === 'number' && typeof r.size.height === 'number'
    && isFiniteRect(r)
}

export function isJson(v: unknown, depth = 0): v is Json {
  if (depth > 64) return false
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((item) => isJson(item, depth + 1))
  if (isObject(v)) return Object.values(v).every((item) => isJson(item, depth + 1))
  return false
}

const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v)

export function checkRecord(v: unknown): Problem {
  if (!isObject(v)) return 'record is not an object'
  if (!isId(v.id)) return 'record id is missing'
  if (!isPanelType(v.type)) return `unknown panel type ${String(v.type)}`
  if (typeof v.title !== 'string') return 'record title is not a string'
  if (!optional(v.worktreeId, isId)) return 'record worktreeId is not an id'
  if (!isObject(v.fields) || !isJson(v.fields)) return 'record fields are not a JSON object'
  if (v.type === 'canvas' ? !isId(v.canvasId) : v.canvasId !== undefined) {
    return 'canvasId belongs on canvas panels, and only there'
  }
  const known = ['id', 'type', 'title', 'worktreeId', 'canvasId', 'fields']
  if (Object.keys(v).some((key) => !known.includes(key))) return 'record has unknown keys'
  return null
}

const isSide = (v: unknown) => (RELATION_SIDES as readonly unknown[]).includes(v)
const isKind = (v: unknown) => (RELATION_KINDS as readonly unknown[]).includes(v)

export function checkRelation(v: unknown): Problem {
  if (!isObject(v)) return 'relation is not an object'
  if (!isId(v.id) || !isId(v.fromPanelId) || !isId(v.toPanelId)) return 'relation ids are missing'
  if (!isKind(v.kind)) return 'unknown relation kind'
  if (!optional(v.label, (x) => typeof x === 'string')) return 'relation label is not a string'
  if (!optional(v.fromSide, isSide) || !optional(v.toSide, isSide)) return 'unknown relation side'
  if (!optional(v.waypoint, isPoint)) return 'relation waypoint is not a point'
  return null
}

export function checkWorktree(v: unknown): Problem {
  if (!isObject(v)) return 'worktree is not an object'
  if (!isId(v.id) || typeof v.path !== 'string' || !v.path) return 'worktree id or path is missing'
  if (typeof v.color !== 'string') return 'worktree color is not a string'
  if (!optional(v.label, (x) => typeof x === 'string')) return 'worktree label is not a string'
  if (!optional(v.prNumber, Number.isInteger)) return 'worktree prNumber is not an integer'
  if (!(WORKTREE_STATUSES as readonly unknown[]).includes(v.status)) return 'unknown worktree status'
  return null
}

/** A dock tree's own shape: stacks with tabs, splits with two or more
 *  children and positive ratios, never inside a split of the same direction.
 *  Ids across trees are checked by the caller. */
export function checkDock(v: unknown, depth = 0, parentDirection?: string): Problem {
  if (depth > 64) return 'dock tree is too deep'
  if (!isObject(v) || !isId(v.id)) return 'dock node has no id'
  const node = v as unknown as DockNode
  if (node.kind === 'stack') {
    if (!Array.isArray(node.panels) || node.panels.length === 0 || !node.panels.every(isId)) {
      return `stack ${node.id} has no tabs`
    }
    return null
  }
  if (node.kind === 'split') {
    if (node.direction !== 'horizontal' && node.direction !== 'vertical') return `split ${node.id} has no direction`
    if (node.direction === parentDirection) return `split ${node.id} runs in its parent's direction`
    if (!Array.isArray(node.children) || node.children.length < 2) return `split ${node.id} has fewer than two children`
    if (!Array.isArray(node.ratios) || node.ratios.length !== node.children.length
      || !node.ratios.every((r) => Number.isFinite(r) && r > 0)) return `split ${node.id} has bad ratios`
    for (const child of node.children) {
      const problem = checkDock(child, depth + 1, node.direction)
      if (problem) return problem
    }
    return null
  }
  return 'dock node is neither a stack nor a split'
}

function checkDockRef(v: unknown): Problem {
  if (!isObject(v)) return 'dock is not an object'
  if ('canvasId' in v) return isId(v.canvasId) && isId(v.nodeId) ? null : 'dock names no node'
  return isId(v.windowId) && isId(v.layoutId) ? null : 'dock names no window layout'
}

const SIDES = ['left', 'right', 'top', 'bottom']

export function checkTarget(v: unknown): Problem {
  if (!isObject(v)) return 'target is not an object'
  const t = v as unknown as PlaceTarget
  switch (t.to) {
    case 'stack':
      return checkDockRef(t.dock) ?? (isId(t.stackId) && (t.after === undefined || t.after === null || isId(t.after))
        ? null : 'bad stack target')
    case 'split':
      return checkDockRef(t.dock) ?? (isId(t.beside) && SIDES.includes(t.side) && isId(t.stackId) && isId(t.splitId)
        ? null : 'bad split target')
    case 'canvas':
      return isId(t.canvasId) && isId(t.nodeId) && isId(t.stackId) && isRect(t.rect) ? null : 'bad canvas target'
    case 'window':
      return isId(t.windowId) && isId(t.layoutId) && isId(t.stackId) && (t.layoutName === undefined || typeof t.layoutName === 'string')
        ? null : 'bad window target'
    default:
      return 'unknown target'
  }
}

function checkPanelPatch(v: unknown): Problem {
  if (!isObject(v)) return 'patch is not an object'
  const p = v as PanelPatch
  if (!optional(p.title, (x) => typeof x === 'string')) return 'patch title is not a string'
  if (!optional(p.worktreeId, (x) => x === null || isId(x))) return 'patch worktreeId is not an id'
  if (!optional(p.fields, (x) => isObject(x) && isJson(x))) return 'patch fields are not a JSON object'
  return null
}

function checkRelationPatch(v: unknown): Problem {
  if (!isObject(v)) return 'patch is not an object'
  const p = v as RelationPatch
  if (!optional(p.kind, isKind)) return 'unknown relation kind'
  if (!optional(p.label, (x) => x === null || typeof x === 'string')) return 'patch label is not a string'
  if (!optional(p.fromSide, (x) => x === null || isSide(x))) return 'unknown relation side'
  if (!optional(p.toSide, (x) => x === null || isSide(x))) return 'unknown relation side'
  if (!optional(p.waypoint, (x) => x === null || isPoint(x))) return 'patch waypoint is not a point'
  return null
}

/** The shape of one change, before any rule is checked against a document. */
export function checkChange(v: unknown): Problem {
  if (!isObject(v)) return 'change is not an object'
  const c = v as DocChange
  switch (c.kind) {
    case 'addPanel': return checkRecord(c.record) ?? checkTarget(c.at)
    case 'replacePanel': return checkRecord(c.record)
    case 'updatePanel': return isId(c.id) ? checkPanelPatch(c.patch) : 'no panel id'
    case 'removePanels':
      return Array.isArray(c.ids) && c.ids.length > 0 && c.ids.every(isId) ? null : 'no panel ids'
    case 'placePanel': return isId(c.id) ? checkTarget(c.at) : 'no panel id'
    case 'setSplitRatio':
      return isId(c.splitId) && Array.isArray(c.ratios) && c.ratios.every((r) => Number.isFinite(r) && r > 0)
        ? null : 'bad split ratios'
    case 'setNodeRects':
      return isId(c.canvasId) && Array.isArray(c.rects)
        && c.rects.every((r) => isObject(r) && isId(r.nodeId) && isRect(r.rect)) ? null : 'bad node rects'
    case 'closeWindow': return isId(c.windowId) ? null : 'no window id'
    case 'addLayout':
      return isId(c.windowId) && isId(c.layoutId) && (c.name === undefined || typeof c.name === 'string')
        && (c.index === undefined || Number.isInteger(c.index)) ? null : 'bad layout'
    case 'removeLayout': return isId(c.windowId) && isId(c.layoutId) ? null : 'bad layout'
    case 'moveLayout':
      return isId(c.windowId) && isId(c.layoutId) && Number.isInteger(c.index) ? null : 'bad layout'
    case 'renameLayout':
      return isId(c.windowId) && isId(c.layoutId) && typeof c.name === 'string' ? null : 'bad layout'
    case 'addRelation': return checkRelation(c.relation)
    case 'updateRelation': return isId(c.id) ? checkRelationPatch(c.patch) : 'no relation id'
    case 'removeRelation': return isId(c.id) ? null : 'no relation id'
    case 'setWorktree': return checkWorktree(c.worktree)
    case 'removeWorktree': return isId(c.id) ? null : 'no worktree id'
    default: return `unknown change ${String((c as { kind?: unknown }).kind)}`
  }
}
