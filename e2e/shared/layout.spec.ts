// Shared workspace, layout: canvases, nodes, stacks, the dock, detached
// windows, renames, relations, worktrees and undo all live in the document,
// so a change from one client shows in the other. Presentation (zoom,
// viewport, active tab) stays per client.

import { test, expect } from '@playwright/test'
import { layout, type DockTree } from '../fixtures/canvas-helpers'
import { activeCanvasId, call, describeShared, doc, moveNode, nodeOf, propose, seedShared, setZoom, snapshot, zoom, type SharedClient } from '../fixtures/shared-workspace'

const place = async (c: SharedClient, panelId: string) => (await layout(c.page, c.workspaceId)).places[panelId] ?? null
const mainDock = async (c: SharedClient) => (await layout(c.page, c.workspaceId)).windows.find((w) => w.kind === 'main')!.dock!
const stacksOf = (tree: DockTree | null): string[][] => !tree ? [] : tree.kind === 'stack' ? [tree.panels] : tree.children.flatMap(stacksOf)

describeShared('layout', (pair) => {
  test('zoom and viewport stay per client', async () => {
    const { a, b } = pair()
    await setZoom(a, 0.8)
    await b.page.waitForTimeout(300)
    expect(await zoom(b)).toBeCloseTo(0.5)
    await setZoom(a, 0.5)
  })

  test('node moves and resizes from either client show in the other', async () => {
    const { a, b } = pair()
    const { nodeId } = await seedShared(pair(), a, 'terminal', { x: 100, y: 100 })
    await moveNode(b, nodeId, { x: 700, y: 120 })
    await expect.poll(async () => (await nodeOf(a, nodeId))?.origin).toEqual({ x: 700, y: 120 })

    const canvasId = await activeCanvasId(a)
    await propose(a, { kind: 'setNodeRects', canvasId, rects: [{ nodeId, rect: { origin: { x: 700, y: 120 }, size: { width: 777, height: 555 } } }] })
    await expect.poll(async () => (await nodeOf(b, nodeId))?.size).toEqual({ width: 777, height: 555 })
    const box = await b.page.locator(`[data-node-id="${nodeId}"]`).boundingBox()
    expect(box!.width).toBeGreaterThan(300)
  })

  test('undo in A reverts A\'s own move for both clients', async () => {
    const { a, b } = pair()
    const { nodeId } = await seedShared(pair(), a, 'terminal', { x: 100, y: 800 })
    await moveNode(a, nodeId, { x: 1400, y: 800 })
    await expect.poll(async () => (await nodeOf(b, nodeId))?.origin).toEqual({ x: 1400, y: 800 })
    // Undo is a keyboard shortcut; text surfaces keep Cmd+Z, so focus the canvas.
    const canvas = await a.page.locator('[data-canvas-container]').first().boundingBox()
    await a.page.mouse.click(canvas!.x + canvas!.width - 20, canvas!.y + canvas!.height - 20)
    await a.page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect.poll(async () => (await nodeOf(b, nodeId))?.origin, { timeout: 10_000 }).toEqual({ x: 100, y: 800 })
    // B cannot undo A's op: B's own undo stack is empty for it.
  })

  test('a rename in B shows on A\'s tab', async () => {
    const { a, b } = pair()
    const { panelId } = await seedShared(pair(), a, 'terminal', { x: 1400, y: 100 })
    await propose(b, { kind: 'updatePanel', id: panelId, patch: { title: 'Renamed by B' } })
    await expect(a.page.locator(`[data-tab-panel-id="${panelId}"]`).first()).toContainText('Renamed by B', { timeout: 15_000 })
  })

  test('stacking one node into another from B shows one tabbed node in A', async () => {
    const { a, b } = pair()
    const first = await seedShared(pair(), a, 'terminal', { x: 100, y: 1500 })
    const second = await seedShared(pair(), a, 'editor', { x: 900, y: 1500 })
    const where = (await place(b, first.panelId))!
    await propose(b, { kind: 'placePanel', id: second.panelId, at: { to: 'stack', dock: { canvasId: where.canvasId, nodeId: where.nodeId }, stackId: where.stackId } })
    await expect.poll(async () => (await place(a, second.panelId))?.nodeId).toBe(first.nodeId)
    await expect(a.page.locator(`[data-node-id="${second.nodeId}"]`)).toHaveCount(0)
    await expect(a.page.locator(`[data-node-id="${first.nodeId}"] [data-tab-panel-id]`)).toHaveCount(2)
  })

  test('a dock split made in A shows in B, and B\'s ratio change shows in A', async () => {
    const { a, b } = pair()
    const root = await mainDock(a)
    const splitId = crypto.randomUUID()
    const panelId = await a.page.evaluate(({ beside, splitId }) => window.__cateE2E!.createPanel('terminal', {
      at: { to: 'split', dock: { windowId: 'main' }, beside, side: 'right', stackId: crypto.randomUUID(), splitId },
    }), { beside: root.id, splitId })
    expect(panelId).toBeTruthy()
    await expect.poll(async () => stacksOf(await mainDock(b)).length).toBe(2)
    await expect(b.page.locator(`[data-dock-window="main"] [data-tab-panel-id="${panelId}"]`)).toBeVisible({ timeout: 15_000 })

    await propose(b, { kind: 'setSplitRatio', splitId, ratios: [0.7, 0.3] })
    await expect.poll(async () => {
      const dock = await mainDock(a)
      return dock.kind === 'split' ? dock.ratios : null
    }).toEqual([0.7, 0.3])

    // Moving a canvas node into the dock from B.
    const node = await seedShared(pair(), a, 'terminal', { x: 1400, y: 1500 })
    const rightStack = stacksOf(await mainDock(b)).findIndex((s) => s.includes(panelId!))
    const dock = await mainDock(b)
    const stackId = dock.kind === 'split' ? (dock.children[rightStack] as { id: string }).id : dock.id
    await propose(b, { kind: 'placePanel', id: node.panelId, at: { to: 'stack', dock: { windowId: 'main' }, stackId } })
    await expect.poll(async () => (await place(a, node.panelId))?.kind).toBe('window')
    await expect(a.page.locator(`[data-node-id="${node.nodeId}"]`)).toHaveCount(0)

    // Closing the split's panels from B collapses A's dock back to one stack.
    await propose(b, { kind: 'removePanels', ids: [panelId!, node.panelId] })
    await expect.poll(async () => stacksOf(await mainDock(a)).length).toBe(1)
  })

  test('after many panels and splits, the canvas tab bar still floats over the canvas in both clients', async () => {
    const { a, b } = pair()
    const added: string[] = []
    for (const side of ['right', 'bottom', 'right', 'bottom'] as const) {
      const root = await mainDock(a)
      const id = await a.page.evaluate(({ beside, side }) => window.__cateE2E!.createPanel('terminal', {
        at: { to: 'split', dock: { windowId: 'main' }, beside, side, stackId: crypto.randomUUID(), splitId: crypto.randomUUID() },
      }), { beside: root.id, side })
      added.push(id!)
    }
    await expect.poll(async () => stacksOf(await mainDock(b)).length).toBe(5)
    for (const c of [a, b]) {
      const canvas = await c.page.evaluate(() => window.__cateE2E!.activeCanvasPanelId())
      const bar = c.page.locator(`[data-dock-stack-id]:has(> .dock-tab-bar [data-tab-panel-id="${canvas}"]) > .dock-tab-bar`)
      await expect(bar).toHaveClass(/dock-tab-bar-floating/, { timeout: 15_000 })
    }
    await propose(a, { kind: 'removePanels', ids: added })
    await expect.poll(async () => stacksOf(await mainDock(b)).length).toBe(1)
  })

  test('a second canvas made in A appears in B\'s dock; removing it in B removes it in A', async () => {
    const { a, b } = pair()
    const before = Object.keys((await doc(a))!.canvases).length
    const canvasPanel = await a.page.evaluate(() => window.__cateE2E!.createPanel('canvas'))
    await expect.poll(async () => Object.keys((await doc(b))?.canvases ?? {}).length).toBe(before + 1)
    await expect(b.page.locator(`.dock-tab-bar [data-tab-panel-id="${canvasPanel}"]`)).toBeVisible({ timeout: 15_000 })
    // A canvas cannot sit on a canvas: the runtime refuses it.
    const canvasId = await activeCanvasId(b)
    await propose(b, { kind: 'placePanel', id: canvasPanel, at: { to: 'canvas', canvasId, nodeId: crypto.randomUUID(), stackId: crypto.randomUUID(), rect: { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } } } })
    await expect.poll(async () => (await place(b, canvasPanel!))?.kind, { timeout: 10_000 }).toBe('window')
    await propose(b, { kind: 'removePanels', ids: [canvasPanel] })
    await expect.poll(async () => Object.keys((await doc(a))?.canvases ?? {}).length).toBe(before)
    // Back to the first canvas in both.
    for (const c of [a, b]) {
      const first = Object.values((await doc(c))!.panels).find((p) => p.type === 'canvas')!.id
      await c.page.locator(`.dock-tab-bar [data-tab-panel-id="${first}"]`).click()
    }
  })

  test('a panel detached in A opens a window in both clients; closing it in B closes both', async () => {
    const { a, b } = pair()
    const { panelId } = await seedShared(pair(), a, 'terminal', { x: 100, y: 2200 })
    const windowId = crypto.randomUUID()
    const beforeA = a.app.electronApp.windows().length
    const beforeB = b.app.electronApp.windows().length
    await propose(a, { kind: 'placePanel', id: panelId, at: { to: 'window', windowId, stackId: crypto.randomUUID(), bounds: { origin: { x: 80, y: 80 }, size: { width: 700, height: 500 } } } })
    for (const c of [a, b]) await expect.poll(async () => (await doc(c))?.windows[windowId]?.kind).toBe('detached')
    await expect.poll(() => a.app.electronApp.windows().length, { timeout: 15_000 }).toBe(beforeA + 1)
    await expect.poll(() => b.app.electronApp.windows().length, { timeout: 15_000 }).toBe(beforeB + 1)

    await propose(b, { kind: 'closeWindow', windowId })
    for (const c of [a, b]) {
      await expect.poll(async () => !!(await doc(c))?.windows[windowId]).toBe(false)
      await expect.poll(async () => !!(await doc(c))?.panels[panelId]).toBe(false)
    }
    await expect.poll(() => a.app.electronApp.windows().length, { timeout: 15_000 }).toBe(beforeA)
    await expect.poll(() => b.app.electronApp.windows().length, { timeout: 15_000 }).toBe(beforeB)
  })

  test('relations added, labelled and removed from either client', async () => {
    const { a, b } = pair()
    const term = await seedShared(pair(), a, 'terminal', { x: 900, y: 2200 })
    const editor = await seedShared(pair(), b, 'editor', { x: 1700, y: 2200 })
    const id = crypto.randomUUID()
    await propose(a, { kind: 'addRelation', relation: { id, fromPanelId: term.panelId, toPanelId: editor.panelId, kind: 'context' } })
    await expect.poll(async () => (await doc(b))?.relations[id]?.kind).toBe('context')
    // The editor is now shared with the agent in the terminal, for both.
    await expect.poll(async () => !!(await snapshot<{ connectedDraft: unknown }>(b, editor.panelId))?.connectedDraft, { timeout: 15_000 }).toBe(true)

    await propose(b, { kind: 'updateRelation', id, patch: { label: 'spec', kind: 'use' } })
    await expect.poll(async () => (await doc(a))?.relations[id]).toMatchObject({ label: 'spec', kind: 'use' })
    await propose(b, { kind: 'removeRelation', id })
    await expect.poll(async () => !!(await doc(a))?.relations[id]).toBe(false)
  })

  test('a worktree created from B is ready for A; its terminal runs there; removing it closes its panels', async () => {
    const { a, b } = pair()
    const worktree = await call<{ id: string; path: string }>(b, 'vcs', 'worktreeCreate', { branch: 'shared-feature' })
    for (const c of [a, b]) await expect.poll(async () => (await doc(c))?.worktrees[worktree.id]?.status, { timeout: 30_000 }).toBe('ready')

    const term = await seedShared(pair(), a, 'terminal', { x: 1700, y: 900 }, { worktreeId: worktree.id })
    await expect.poll(async () => (await snapshot<{ cwd: string | null }>(b, term.panelId))?.cwd, { timeout: 20_000 }).toBe(worktree.path)
    const list = await call<{ path: string }[]>(a, 'vcs', 'worktreeList', {})
    expect(list.map((w) => w.path)).toContain(worktree.path)

    await call(a, 'vcs', 'worktreeRemove', { worktreeId: worktree.id, force: true })
    for (const c of [a, b]) {
      await expect.poll(async () => !!(await doc(c))?.worktrees[worktree.id], { timeout: 30_000 }).toBe(false)
      await expect.poll(async () => !!(await doc(c))?.panels[term.panelId], { timeout: 15_000 }).toBe(false)
    }
  })
})
