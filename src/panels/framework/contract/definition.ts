// What a panel type is (architecture 11.1, 11.2): `panels/<type>/definition.ts`
// declares it once with `definePanel`. Pure: the daemon imports definitions,
// so they hold no components and no function that touches a session.

import type { CateApiNamespace } from '@kernel/api/contract'
import type { StoredShortcut } from '@kernel/interaction/contract'
import { isClientFeature, type ChannelSchema, type ClientFeature } from '@kernel/rpc/contract'
import type { Point, Size } from '@workspace/canvas/contract'
import type { RelationRole } from '@workspace/relations/contract'
import type {
  JsonObject,
  PanelId,
  PanelRecord,
  PanelType,
  PlaceTarget,
  WorkspaceDocument,
} from '@workspace/document/contract'

/** Where a new panel goes. `at` wins; otherwise next to `near` (on its canvas
 *  or after it in its stack), otherwise the main window. */
export interface PanelPlacementOptions {
  at?: PlaceTarget
  near?: PanelId
  /** Canvas point to place near, when the panel lands on a canvas. */
  position?: Point
}

/** What every create accepts; a type's own options extend it. */
export interface PanelCreateOptions extends PanelPlacementOptions {
  title?: string
  worktreeId?: string
  /** Grouping for panels a `cate` caller creates (kernel/api targeting). */
  placementGroupId?: string
}

export interface PanelRecordInit {
  id: PanelId
  title?: string
  worktreeId?: string
  /** Canvas panels only: the canvas the new panel shows. */
  canvasId?: string
  fields?: JsonObject
}

/** Document access handed to `create`, so definitions stay pure. */
export interface PanelKit {
  newId(): PanelId
  /** A fresh record of `type`: its default title and the init's fields. */
  record(type: PanelType, init: PanelRecordInit): PanelRecord
  /** Adds and places the record; null when the placement failed. */
  add(record: PanelRecord, placement?: PanelPlacementOptions): PanelId | null
  document(): WorkspaceDocument
  /** "<base> N", unique among the document's panels of `type`. */
  numberedTitle(type: PanelType, base: string): string
  /** A chosen title made unique among the other panels. */
  uniqueTitle(title: string, panelId: PanelId): string
  worktreeIdForPath(path: string | undefined): string | undefined
}

/** An action of the focused panel (`panel.<type>.<id>`): a session op to
 *  send to it. Listed in the palette while a panel of the type is focused. */
export interface PanelCommand<Op = unknown> {
  id: string
  title: string
  /** A key the view handles itself, shown next to the title. */
  keyHint?: string
  op: Op
  /** Also listed in the menu bar's Panel menu, under the type's label. */
  menu?: boolean
  /** Hidden on clients without these features. */
  requires?: readonly ClientFeature[]
}

/** How people create a panel of the type: one `panel.new.<type>` action
 *  ("New <label>") and an entry in every creation menu (the canvas menu, the
 *  dock's new-tab menu, the empty dock, a surface's picker, the relation
 *  handle, the palette, File > New). */
export interface PanelCreation {
  /** Position in every creation menu. */
  order: number
  /** The action's and menus' title; defaults to "New <label>". */
  title?: string
  /** Default key of the `panel.new.<type>` action. */
  key?: StoredShortcut
  /** A new-panel button on the canvas toolbar. */
  toolbar?: boolean
  /** Created in a checkout: menus offer each ready worktree. */
  inWorktree?: boolean
}

/** A generic "open" action a panel type serves (`opens`). */
export type PanelOpenKind = 'file' | 'directory' | 'url' | 'conversation'

export interface PanelDefinition<
  Type extends PanelType = PanelType,
  Snapshot = unknown,
  Op = unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Options extends PanelCreateOptions = any,
> {
  type: Type
  // --- Presentation ----------------------------------------------------------
  label: string
  /** An icon name the client's icon set resolves. */
  icon: string
  /** Style class of the icon on an active tab (a text color). */
  tint?: string
  defaultSize: Size
  minimumSize: Size
  /** Compact size for a drop onto a canvas from a dock; defaults to `defaultSize`. */
  dropSize?: Size
  // --- Flags -----------------------------------------------------------------
  /** False for containers that only live in docks (a canvas). */
  canLiveOnCanvas: boolean
  /** A live panel switches checkout through its session (`switchWorktree`
   *  op); other types just rebind the record. */
  switchesWorktree?: boolean
  /** Offered as a destination in the command palette. */
  navigable?: boolean
  /** People create it from menus; omitted for types only code creates. */
  creation?: PanelCreation
  /** What generic "open" actions create this type for, with the create
   *  option each passes: `file` (`filePath`; the session takes
   *  `openFile {path, line?, column?}`), `directory` (`cwd`), `url` (`url`;
   *  the session takes `newTab {url}`), `conversation` (`threadId`). The
   *  first registered type wins. */
  opens?: readonly PanelOpenKind[]
  /** A picker that becomes the type the user chooses (`replacePanel`): what
   *  "Split Right" creates. At most one type sets it. */
  placeholder?: boolean
  /** The view hosts a native surface the client keeps mounted. */
  surface?: { retention: 'workspace' | 'recent' }
  /** False when the panel works without a project folder (a browser). */
  requiresFolder?: boolean
  // --- Record, schemas, API --------------------------------------------------
  /** Title of a fresh record when the creator gives none. */
  defaultTitle: string
  /** The type's fields on a fresh record. */
  fields?: (options: Options) => JsonObject
  /** The session channel: snapshot, change and op types, and the kind of
   *  byte stream it carries. */
  channel: ChannelSchema<Snapshot, Partial<Snapshot>, Op>
  /** The `cate.<type>.*` spec the session's `handleApi` serves. */
  api?: CateApiNamespace<any>
  /** Creates a panel through `kit`; defaults to one record with `fields`
   *  placed per the options. Returns the id, or null. */
  create?: (options: Options, kit: PanelKit) => PanelId | null
  // --- Hooks generic code asks instead of branching on the type -------------
  /** The checkout this panel works in (a terminal's cwd, an editor's file). */
  checkoutPath?: (record: PanelRecord) => string | undefined
  /** Raw keystrokes belong to the focused panel; app shortcuts yield. */
  ownsKeyboard?: boolean
  /** App shortcut actions the panel handles itself while focused. */
  claimsShortcuts?: readonly string[]
  commands?: readonly PanelCommand<Op>[]
  /** Secondary line in the palette's panel list (default: the label). */
  describe?: (record: PanelRecord) => string | undefined
  /** Dock chrome: `flushTabBar` drops the tab bar divider; `worktreeChip`
   *  shows the checkout chip; `floatingTabBar` floats the tab bar over the
   *  view (a canvas, whose grid shows behind it; its tab also springs open
   *  sooner during a drag, since it is a drop surface). */
  chrome?: { flushTabBar?: boolean; worktreeChip?: boolean; floatingTabBar?: boolean }
  /** How the type takes part in relation flows (prompt context, connected
   *  editors, the intents offered when connecting panels). */
  relation?: RelationRole
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPanelDefinition = PanelDefinition<PanelType, any, any, any>

/** Declares a panel type. `const` keeps literal flags visible to derived types. */
export const definePanel = <const Definition extends AnyPanelDefinition>(definition: Definition): Definition => definition

export type SnapshotOfPanel<D> = D extends PanelDefinition<PanelType, infer S, unknown> ? S : never
export type OpOfPanel<D> = D extends PanelDefinition<PanelType, unknown, infer Op> ? Op : never

/** What is wrong with a definition; empty when nothing. The contract test
 *  runs it over every definition. */
export function definitionProblems(definition: AnyPanelDefinition): string[] {
  const problems: string[] = []
  const unknownFeatures = (list: readonly unknown[] | undefined, where: string) => {
    for (const feature of list ?? []) if (!isClientFeature(feature)) problems.push(`${where} requires unknown feature "${String(feature)}"`)
  }
  for (const command of definition.commands ?? []) unknownFeatures(command.requires, `command ${command.id}`)
  if (typeof definition.icon !== 'string' || !definition.icon) problems.push('icon must be a name')
  if (definition.creation && !Number.isFinite(definition.creation.order)) problems.push('creation order must be a number')
  if (definition.channel?.kind !== 'channel') problems.push('channel schema is missing')
  return problems
}
