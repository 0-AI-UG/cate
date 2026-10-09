import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { documentStoreFor } from '@client/document'
import { registerPanelDefinitions } from '@client/host'
import { openTestDocument } from '../../client/layout/canvas/testing'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { MAIN_WINDOW, createDocument, type DockNode, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import { besideTree } from './besideTree'
import { ensureFilesTree } from './filesTreeOnOpen'

const panel = (id: string, fields = {}): PanelRecord => ({ id, type: 'terminal', title: id, fields })
const tree: PanelRecord = { id: 'tree', type: 'editor', title: 'Files', fields: { treeOnly: true } }
const stack = (id: string, ...panels: string[]): DockNode => ({ kind: 'stack', id, panels })

let detach: () => void = () => {}
const open = (panels: PanelRecord[], dock: DockNode | null) => {
  detach = openTestDocument('ws', {
    ...createDocument(),
    panels: Object.fromEntries(panels.map((p) => [p.id, p])),
    windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock } },
  })
}
const doc = () => documentStoreFor('ws')!.getSnapshot()
const mainDock = () => doc().windows[MAIN_WINDOW].dock

beforeEach(() => registerPanelDefinitions(PANEL_DEFINITIONS))
afterEach(() => detach())

describe('ensureFilesTree', () => {
  it('docks a narrow tree-only Files panel at the chosen side', () => {
    open([panel('a')], stack('s1', 'a'))
    const id = ensureFilesTree('ws', 'left')!
    expect(doc().panels[id]).toMatchObject({ type: 'editor', title: 'Files', fields: { treeOnly: true } })
    const root = mainDock()
    expect(root).toMatchObject({ kind: 'split', direction: 'horizontal', ratios: [0.2, 0.8] })
    expect(root?.kind === 'split' && root.children[0].kind === 'stack' && root.children[0].panels).toEqual([id])
  })

  it('keeps the other columns in proportion', () => {
    open([panel('a'), panel('b')], { kind: 'split', id: 'sp', direction: 'horizontal', children: [stack('s1', 'a'), stack('s2', 'b')], ratios: [0.75, 0.25] })
    ensureFilesTree('ws', 'right')
    const root = mainDock()
    expect(root?.kind === 'split' && root.ratios.map((r) => Math.round(r * 100))).toEqual([60, 20, 20])
  })

  it('fills an empty main window', () => {
    open([], null)
    const id = ensureFilesTree('ws', 'left')!
    expect(mainDock()).toMatchObject({ kind: 'stack', panels: [id] })
  })

  it('does nothing when a tree-only Files panel is already docked', () => {
    open([panel('a'), tree], stack('s1', 'a', 'tree'))
    const before = doc()
    expect(ensureFilesTree('ws', 'left')).toBeNull()
    expect(doc()).toBe(before)
  })
})

describe('besideTree', () => {
  const docWith = (dock: DockNode): WorkspaceDocument => ({
    ...createDocument(),
    panels: { tree, a: panel('a') },
    windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock } },
  })

  it('uses the stack next to the tree', () => {
    const placement = besideTree(docWith({ kind: 'split', id: 'sp', direction: 'horizontal', children: [stack('s1', 'tree'), stack('s2', 'a')], ratios: [0.2, 0.8] }), 'tree')
    expect(placement).toEqual({ at: { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's2' } })
  })

  it('splits off to the right when the tree is alone', () => {
    const placement = besideTree(docWith(stack('s1', 'tree', 'a')), 'tree')
    expect(placement.at).toMatchObject({ to: 'split', dock: { windowId: MAIN_WINDOW }, beside: 's1', side: 'right' })
  })

  it('goes near the tree when it is not docked', () => {
    expect(besideTree(createDocument(), 'tree')).toEqual({ near: 'tree' })
  })
})
