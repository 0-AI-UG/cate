import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, placementOf } from '@workspace/document/contract'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../layout/testing'
import { registerAction, registerHostActions, runAction, onPanelRenameRequest } from './actions'
import { closePanel, closePanels, registerPanelCloseGuard } from './close'
import { placeTargetFor } from '@panels/framework/contract'
import { documentStoreFor } from '@client/document'
import { createPanel, newId } from './createPanel'
import { registerPanelDefinitions } from './definitions'
import { focusedLeafPanelId } from './focus'
import { CANVAS_REVEAL_INTENT, revealPanel } from './reveal'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { windowId: MAIN_WINDOW }
const rect = { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } }

function fixture() {
  return buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('t1', { to: 'stack', dock: main, stackId: 's1' }, 'terminal', { worktreeId: 'wt' }),
    add('a', { to: 'canvas', canvasId: 'C', nodeId: 'N1', stackId: 'ns1', rect }),
  ])
}

let ws: TestWorkspace | null = null
afterEach(() => {
  ws?.detach()
  ws = null
})

describe('createPanel', () => {
  it('goes after `near` in its stack, inherits its worktree, and becomes the shown, focused tab', () => {
    ws = attachTestWorkspace('w', fixture())
    const id = createPanel('w', 'editor', { near: 't1' })!
    const doc = ws.confirmed()
    expect(placementOf(doc, id)).toMatchObject({ stackId: 's1', index: 2 })
    expect(doc.panels[id]).toMatchObject({ type: 'editor', title: 'editor', worktreeId: 'wt' })
    expect(ws.state.getSnapshot().activeTabs.s1).toBe(id)
    expect(ws.state.getSnapshot().focusedPanelId).toBe(id)
  })

  it('near a canvas panel or a panel on a canvas: a new node on that canvas', () => {
    ws = attachTestWorkspace('w', fixture())
    const onCanvas = createPanel('w', 'terminal', { near: 'cv' })!
    const beside = createPanel('w', 'terminal', { near: 'a' })!
    const doc = ws.confirmed()
    expect(placementOf(doc, onCanvas)?.dock).toMatchObject({ canvasId: 'C' })
    expect(placementOf(doc, beside)?.dock).toMatchObject({ canvasId: 'C' })
  })

  it('a type that cannot live on a canvas goes after the canvas panel', () => {
    const canvas = testPanelDefinitions().find((d) => d.type === 'canvas')!
    expect(placeTargetFor(fixture(), canvas, { near: 'a' }, newId)).toEqual({ to: 'stack', dock: main, stackId: 's1', after: 'cv' })
  })

  it('without options: the first stack of the main window, or a new one', () => {
    ws = attachTestWorkspace('w')
    const first = createPanel('w', 'terminal')!
    const second = createPanel('w', 'terminal')!
    const doc = ws.confirmed()
    expect(placementOf(doc, second)?.stackId).toBe(placementOf(doc, first)?.stackId)
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
  it('a focused canvas descends into its selected node', () => {
    ws = attachTestWorkspace('w', fixture())
    ws.state.focus('cv')
    expect(focusedLeafPanelId('w')).toBe('cv')
    ws.state.setSelection('C', ['N1'])
    expect(focusedLeafPanelId('w')).toBe('a')
  })

  it('reveal selects the tabs up the chain, the node, and asks the canvas to centre it', async () => {
    ws = attachTestWorkspace('w', fixture())
    ws.state.setActiveTab('s1', 't1')
    expect(await revealPanel('w', 'a')).toBe(true)
    const state = ws.state.getSnapshot()
    expect(state.activeTabs).toMatchObject({ s1: 'cv', ns1: 'a' })
    expect(state.selection.C).toEqual(['N1'])
    expect(state.focusedPanelId).toBe('a')
    expect(ws.state.takeIntents('cv')).toEqual([expect.objectContaining({ kind: CANVAS_REVEAL_INTENT, data: { nodeId: 'N1', panelId: 'a' } })])
  })
})

describe('actions', () => {
  it('runs registered handlers by id and says when none handles it', async () => {
    const handler = vi.fn()
    const stop = registerAction('test.action', handler)
    expect(await runAction('test.action', { workspaceId: 'w' })).toBe(true)
    expect(handler).toHaveBeenCalledWith({ workspaceId: 'w' })
    expect(await runAction('missing', { workspaceId: 'w' })).toBe(false)
    stop()
  })

  it('host actions: new panel beside the focused one, rename request', async () => {
    ws = attachTestWorkspace('w', fixture())
    const stop = registerHostActions()
    ws.state.focus('t1')
    await runAction('new:editor', { workspaceId: 'w' })
    expect(Object.values(ws.confirmed().panels).filter((p) => p.type === 'editor')).toHaveLength(1)
    const renames: string[] = []
    const off = onPanelRenameRequest((_, id) => renames.push(id))
    ws.state.focus('t1')
    await runAction('renamePanel', { workspaceId: 'w' })
    expect(renames).toEqual(['t1'])
    off()
    stop()
  })
})
