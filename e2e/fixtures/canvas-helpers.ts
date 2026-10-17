// Document-derived views for canvas, dock and drag specs. They read the
// client's document mirror (`__cateE2E.document()`), which is the state the
// old `dockDebug` / `canvasDebug` hooks summarized.

import type { Page } from 'playwright'

export type DockTree =
  | { kind: 'stack'; id: string; panels: string[] }
  | { kind: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: DockTree[]; ratios: number[] }

export interface Where {
  /** 'window' for a window's dock, 'canvas' for a canvas node's mini dock. */
  kind: 'window' | 'canvas'
  windowId?: string
  canvasId?: string
  nodeId?: string
  stackId: string
}

export interface Layout {
  windows: { id: string; kind: string; dock: DockTree | null }[]
  canvases: { id: string; nodes: { id: string; dock: DockTree; rect: { origin: { x: number; y: number }; size: { width: number; height: number } } }[] }[]
  places: Record<string, Where>
}

/** Every window dock, every canvas node, and where each panel sits. */
export async function layout(page: Page, workspaceId?: string): Promise<Layout> {
  return page.evaluate((ws) => {
    const doc = window.__cateE2E!.document(ws ?? undefined) as unknown as {
      windows: Record<string, { id: string; kind: string; dock: DockTree | null }>
      canvases: Record<string, { id: string; nodes: Record<string, { id: string; dock: DockTree; rect: never }> }>
    } | null
    const places: Record<string, Where> = {}
    const visit = (node: DockTree | null, at: Omit<Where, 'stackId'>) => {
      if (!node) return
      if (node.kind === 'stack') for (const p of node.panels) places[p] = { ...at, stackId: node.id }
      else for (const child of node.children) visit(child, at)
    }
    if (!doc) return { windows: [], canvases: [], places }
    for (const w of Object.values(doc.windows)) visit(w.dock, { kind: 'window', windowId: w.id })
    for (const c of Object.values(doc.canvases)) {
      for (const n of Object.values(c.nodes)) visit(n.dock, { kind: 'canvas', canvasId: c.id, nodeId: n.id })
    }
    return {
      windows: Object.values(doc.windows),
      canvases: Object.values(doc.canvases).map((c) => ({ id: c.id, nodes: Object.values(c.nodes) })),
      places,
    }
  }, workspaceId ?? null)
}

export async function whereIs(page: Page, panelId: string): Promise<Where | null> {
  return (await layout(page)).places[panelId] ?? null
}

/** Panels of every stack in the main window's dock, in tree order. */
export async function mainWindowStacks(page: Page): Promise<string[][]> {
  const { windows } = await layout(page)
  const main = windows.find((w) => w.kind === 'main')
  const stacks: string[][] = []
  const visit = (node: DockTree | null) => {
    if (!node) return
    if (node.kind === 'stack') stacks.push(node.panels)
    else node.children.forEach(visit)
  }
  visit(main?.dock ?? null)
  return stacks
}

/** Removes every panel but the canvas panels (old `clearCanvas`). */
export async function clearPanels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const doc = window.__cateE2E!.document() as unknown as { panels: Record<string, { id: string; type: string }> } | null
    if (!doc) return
    const ids = Object.values(doc.panels).filter((p) => p.type !== 'canvas').map((p) => p.id)
    if (ids.length) window.__cateE2E!.propose({ kind: 'removePanels', ids } as never)
  })
}

/** The panel ids of the node's mini dock, in tree order. */
export async function nodePanels(page: Page, nodeId: string): Promise<string[]> {
  const { places } = await layout(page)
  return Object.entries(places).filter(([, w]) => w.nodeId === nodeId).map(([id]) => id)
}
