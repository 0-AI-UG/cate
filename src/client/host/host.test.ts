import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { canvasOf, MAIN_WINDOW, placementOf } from '@workspace/document/contract'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../test/clientWorkspace'
import { actionSpec, declaredActions } from '@kernel/interaction'
import { storedShortcut } from '@kernel/interaction/contract'
import { canRunAction, registerActions, requestPanelRename, runAction, onPanelRenameRequest } from './actions'
import { creationMenuItems, creationPick, worktreeChoices } from './creation'
import { registerPanelActions } from './panelActions'
import { closePanel, closePanels, registerPanelCloseGuard } from './close'
import { placeTargetFor } from '@panels/framework/contract'
import { documentStoreFor } from '@client/document'
import { createPanel, newId } from './createPanel'
import { creatableDefinitions, panelDefinition, registerPanelDefinitions } from './definitions'
import { focusedLeafPanelId } from './focus'
import { CANVAS_REVEAL_INTENT, installRevealHooks, revealOnce, revealPanel, selectPanelAt, stepPanel } from './reveal'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { layoutId: 'main' }
const rect = { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } }

function fixture() {
  return buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('t1', { to: 'stack', dock: main, stackId: 's1' }, 'terminal', { worktreeId: 'wt' }),
    add('a', { to: 'canvas', canvasId: 'C', nodeId: 'N1', layoutId: 'L-N1', stackId: 'ns1', rect }),
  ])
}

let ws: TestWorkspace | null = null
afterEach(() => {
  ws?.detach()
  ws = null
})

describe('createPanel', () => {
  it('becomes a new tab after the layout of `near`, inherits its worktree, and is shown and focused', () => {
    ws = attachTestWorkspace('w', fixture())
    const id = createPanel('w', 'editor', { near: 't1' })!
    const doc = ws.confirmed()
    const placement = placementOf(doc, id)!
    expect(doc.windows.main.layouts.map((l) => l.id)).toEqual(['main', placement.dock.layoutId])
    expect(placement.index).toBe(0)
    expect(doc.panels[id]).toMatchObject({ type: 'editor', title: 'editor', worktreeId: 'wt' })
    expect(ws.state.getSnapshot().activeLayouts.main).toBe(placement.dock.layoutId)
    expect(ws.state.getSnapshot().activeTabs[placement.stackId]).toBe(id)
    expect(ws.state.getSnapshot().focusedPanelId).toBe(id)
  })

  it('near a canvas panel or a panel on a canvas: a new node on that canvas', () => {
    ws = attachTestWorkspace('w', fixture())
    const onCanvas = createPanel('w', 'terminal', { near: 'cv' })!
    const beside = createPanel('w', 'terminal', { near: 'a' })!
    const doc = ws.confirmed()
    expect(canvasOf(doc, onCanvas)).toBe('C')
    expect(canvasOf(doc, beside)).toBe('C')
  })

  it('a type that cannot live on a canvas goes after the canvas panel', () => {
    const canvas = testPanelDefinitions().find((d) => d.type === 'canvas')!
    expect(placeTargetFor(fixture(), canvas, { near: 'a' }, newId)).toMatchObject({ to: 'tab', host: { windowId: 'main' }, index: 1 })
  })

  it('without options: the empty main layout, then a new tab after the shown one', () => {
    ws = attachTestWorkspace('w')
    const first = createPanel('w', 'terminal')!
    const second = createPanel('w', 'terminal')!
    const doc = ws.confirmed()
    expect(placementOf(doc, first)?.dock).toEqual(main)
    expect(doc.windows.main.layouts.map((l) => l.id)).toEqual(['main', placementOf(doc, second)!.dock.layoutId])
  })

  it('an unknown type creates nothing', () => {
    ws = attachTestWorkspace('w')
    expect(createPanel('w', 'nope')).toBeNull()
  })
})

describe('closing', () => {
  it('asks the type guard with a session, then removes', async () => {
    ws = attachTestWorkspace('w', fixture())
    const guard = vi.fn().mockResolvedValue(true)
    const stop = registerPanelCloseGuard('terminal', guard)
    expect(await closePanel('w', 't1')).toBe(true)
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w', record: expect.objectContaining({ id: 't1' }) }))
    expect(ws.confirmed().panels.t1).toBeUndefined()
    stop()
  })

  it('a declining guard keeps every panel', async () => {
    ws = attachTestWorkspace('w', fixture())
    const stop = registerPanelCloseGuard('terminal', () => false)
    expect(await closePanels('w', ['t1', 'cv'])).toBe(false)
    expect(Object.keys(ws.confirmed().panels).sort()).toEqual(['a', 'cv', 't1'])
    stop()
  })

  it('closing a canvas asks for the panels on it too', async () => {
    ws = attachTestWorkspace('w', fixture())
    const seen: string[] = []
    const stop = registerPanelCloseGuard('terminal', ({ record }) => { seen.push(record.id); return true })
    await closePanel('w', 'cv')
    expect(seen).toEqual(['a'])
    expect(ws.confirmed().panels.a).toBeUndefined()
    stop()
  })

  it('panels a guard moved out of the close are not asked about and stay', async () => {
    ws = attachTestWorkspace('w', fixture())
    const seen: string[] = []
    const stopTerminal = registerPanelCloseGuard('terminal', ({ record }) => { seen.push(record.id); return true })
    const stopCanvas = registerPanelCloseGuard('canvas', ({ workspaceId }) => {
      documentStoreFor(workspaceId)!.propose({ kind: 'placePanel', id: 'a', at: { to: 'stack', dock: main, stackId: 's1' } })
      return true
    })
    expect(await closePanel('w', 'cv')).toBe(true)
    expect(seen).toEqual([])
    expect(ws.confirmed().panels.a).toBeDefined()
    expect(ws.confirmed().panels.cv).toBeUndefined()
    stopTerminal()
    stopCanvas()
  })
})

describe('focus and reveal', () => {
  it('a focused canvas descends into its active node', () => {
    ws = attachTestWorkspace('w', fixture())
    ws.state.focus('cv')
    expect(focusedLeafPanelId('w')).toBe('cv')
    ws.state.setSelection('C', { nodes: ['N1'], active: null })
    expect(focusedLeafPanelId('w')).toBe('cv')
    ws.state.setSelection('C', { nodes: ['N1'], active: 'N1' })
    expect(focusedLeafPanelId('w')).toBe('a')
  })

  it('reveal selects the tabs up the chain, the node, and asks the canvas to centre it', async () => {
    ws = attachTestWorkspace('w', fixture())
    ws.state.setActiveTab('s1', 't1')
    expect(await revealPanel('w', 'a')).toBe(true)
    const state = ws.state.getSnapshot()
    expect(state.activeTabs).toMatchObject({ s1: 'cv', ns1: 'a' })
    expect(state.selection.C).toEqual({ nodes: ['N1'], active: 'N1' })
    expect(state.focusedPanelId).toBe('a')
    expect(ws.state.takeIntents('cv')).toEqual([expect.objectContaining({ kind: CANVAS_REVEAL_INTENT, data: { nodeId: 'N1', panelId: 'a' } })])
  })
})

describe('actions', () => {
  it('declares and binds in one call, runs by id, and withdraws both', async () => {
    const handler = vi.fn()
    const stop = registerActions({ 'test.action': { title: 'Test', key: storedShortcut('j', { command: true }) } }, { 'test.action': { run: handler } })
    expect(actionSpec('test.action')?.title).toBe('Test')
    expect(await runAction('test.action', { workspaceId: 'w' })).toBe(true)
    expect(handler).toHaveBeenCalledWith({ workspaceId: 'w' })
    stop()
    expect(actionSpec('test.action')).toBeUndefined()
    expect(await runAction('test.action', { workspaceId: 'w' })).toBe(false)
  })

  it('does not run an action that is disabled for the context', async () => {
    const run = vi.fn()
    const stop = registerActions({ 'test.gated': { title: 'Gated' } }, { 'test.gated': { run, enabled: ({ workspaceId }) => workspaceId === 'ok' } })
    expect(canRunAction('test.gated', { workspaceId: 'no' })).toBe(false)
    expect(await runAction('test.gated', { workspaceId: 'no' })).toBe(false)
    expect(await runAction('test.gated', { workspaceId: 'ok' })).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    stop()
  })

  it('derives a new-panel action per creatable type, in creation order', async () => {
    ws = attachTestWorkspace('w', fixture())
    const created: string[] = []
    const stop = registerPanelActions((type, { workspaceId }) => { created.push(type); createPanel(workspaceId!, type) })
    const ids = declaredActions().map((a) => a.id).filter((id) => id.startsWith('panel.new.'))
    expect(ids).toEqual(creatableDefinitions().map((d) => `panel.new.${d.type}`))
    expect(actionSpec('panel.new.terminal')).toMatchObject({ title: 'New Terminal', menu: { bar: 'file', group: 'new' } })
    expect(actionSpec('panel.new.canvas')).toBeUndefined()
    await runAction('panel.new.editor', { workspaceId: 'w' })
    expect(created).toEqual(['editor'])
    expect(Object.values(ws.confirmed().panels).filter((p) => p.type === 'editor')).toHaveLength(1)
    stop()
    expect(actionSpec('panel.new.editor')).toBeUndefined()
  })

  it('panel commands run only while a panel of the type is focused', async () => {
    const terminal = panelDefinition('terminal')!
    registerPanelDefinitions([{ ...terminal, commands: [{ id: 'restart', title: 'Restart', op: { kind: 'restart' }, menu: true }] }])
    ws = attachTestWorkspace('w', fixture())
    const stop = registerPanelActions(() => {})
    expect(actionSpec('panel.terminal.restart')?.menu).toEqual({ bar: 'panel', group: 'terminal', submenu: terminal.label })
    ws.state.focus('t1')
    expect(canRunAction('panel.terminal.restart', { workspaceId: 'w' })).toBe(true)
    ws.state.focus('cv')
    expect(canRunAction('panel.terminal.restart', { workspaceId: 'w' })).toBe(false)
    stop()
    registerPanelDefinitions([terminal])
  })

  it('hands a rename request to the docks', () => {
    const renames: string[] = []
    const off = onPanelRenameRequest((_, id) => renames.push(id))
    requestPanelRename('w', 't1')
    expect(renames).toEqual(['t1'])
    off()
  })
})

describe('creation menus', () => {
  const worktrees = worktreeChoices({
    a: { id: 'a', path: '/repo', color: '#fff', status: 'ready' },
    b: { id: 'b', path: '/repo/.cate/worktrees/feat', color: '#000', label: 'feat', status: 'ready' },
    c: { id: 'c', path: '/repo/.cate/worktrees/new', color: '#000', status: 'creating' },
  })

  it('offers each ready worktree for a type created in a checkout', () => {
    expect(worktrees.map((w) => w.label)).toEqual(['repo (primary)', 'feat'])
    const terminal = { ...panelDefinition('terminal')!, creation: { order: 1, inWorktree: true } }
    const editor = panelDefinition('editor')!
    const items = creationMenuItems([terminal, editor], worktrees)
    expect(items).toEqual([
      { label: 'New Terminal', submenu: [{ id: 'new:terminal:a', label: 'repo (primary)' }, { id: 'new:terminal:b', label: 'feat' }] },
      { id: 'new:editor', label: 'New Editor' },
    ])
    expect(creationMenuItems([terminal], worktrees.slice(0, 1))).toEqual([{ id: 'new:terminal', label: 'New Terminal' }])
  })

  it('turns a pick into the type and its checkout', () => {
    expect(creationPick('new:terminal:b', worktrees)).toEqual({ type: 'terminal', options: { worktreeId: 'b', cwd: '/repo/.cate/worktrees/feat' } })
    expect(creationPick('new:editor', worktrees)).toEqual({ type: 'editor', options: {} })
    expect(creationPick('close', worktrees)).toBeNull()
    expect(creationPick(null, worktrees)).toBeNull()
  })
})

// Two layouts: the main one (a canvas with a node, a terminal) and a second tab (a panel, a canvas).
const second = () => buildDocument([
  add('b', { to: 'tab', host: { windowId: MAIN_WINDOW }, layoutId: 'T2', stackId: 's2' }),
  add('cv2', { to: 'stack', dock: { layoutId: 'T2' }, stackId: 's2' }, 'canvas', { canvasId: 'C2' }),
], fixture())

describe('revealing in another window', () => {
  const inWindow = () => buildDocument([add('far', { to: 'window', windowId: 'W1', layoutId: 'W1-main', stackId: 'ws1' }), add('far2', { to: 'stack', dock: { layoutId: 'W1-main' }, stackId: 'ws1' })])

  it('asks the shell to show the panel in its window (the tab selection is that window\'s own)', () => {
    ws = attachTestWorkspace('w', inWindow())
    const showWindow = vi.fn()
    const stop = installRevealHooks({ showWindow })
    expect(revealOnce('w', 'far2')).toBe(true)
    expect(showWindow).toHaveBeenCalledWith('w', 'W1', 'far2')
    stop()
  })

  it('a reveal another window asked for sets only this window\'s state and asks nobody', () => {
    ws = attachTestWorkspace('w', inWindow())
    const showWindow = vi.fn()
    const stop = installRevealHooks({ showWindow })
    expect(revealOnce('w', 'far2', { local: true })).toBe(true)
    expect(showWindow).not.toHaveBeenCalled()
    expect(ws.state.getSnapshot().activeTabs.ws1).toBe('far2')
    expect(ws.state.getSnapshot().focusedPanelId).toBe('far2')
    stop()
  })
})

describe('panel order', () => {
  it('Alt+N and Ctrl+Tab follow the strip: the docks of each layout in turn, canvas nodes left out', () => {
    ws = attachTestWorkspace('w', second())
    expect(selectPanelAt('w', MAIN_WINDOW, 1)).toBe(true)
    expect(ws.state.getSnapshot().focusedPanelId).toBe('t1')
    expect(selectPanelAt('w', MAIN_WINDOW, 2)).toBe(true)
    expect(ws.state.getSnapshot().focusedPanelId).toBe('b')
    expect(ws.state.getSnapshot().activeLayouts.main).toBe('T2')
    expect(selectPanelAt('w', MAIN_WINDOW, 9)).toBe(false)
    expect(stepPanel('w', MAIN_WINDOW, -1)).toBe(true)
    expect(ws.state.getSnapshot().focusedPanelId).toBe('t1')
    expect(stepPanel('w', MAIN_WINDOW, 1)).toBe(true)
    expect(stepPanel('w', MAIN_WINDOW, 1)).toBe(true)
    expect(ws.state.getSnapshot().focusedPanelId).toBe('cv2')
  })

  it('a panel created on a canvas in a hidden layout shows that layout', () => {
    ws = attachTestWorkspace('w', second())
    expect(ws.state.getSnapshot().activeLayouts.main).toBeUndefined()
    const id = createPanel('w', 'terminal', { near: 'cv2' })!
    expect(canvasOf(ws.confirmed(), id)).toBe('C2')
    expect(ws.state.getSnapshot().activeLayouts.main).toBe('T2')
  })
})
