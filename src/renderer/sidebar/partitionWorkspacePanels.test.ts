import { describe, it, expect } from 'vitest'
import {
  partitionWorkspacePanels,
  buildColdStartCanvasChildOwners,
  type PanelLike,
} from './partitionWorkspacePanels'

const panel = (id: string, type: string): PanelLike => ({ id, type })

describe('partitionWorkspacePanels', () => {
  // Regression: a workspace with two canvases, each hosting two terminals, used
  // to collapse ALL children under the first canvas (the grouping hardcoded
  // canvasPanels[0]). Each child must nest under the canvas that actually owns
  // it.
  it('nests each child under its own canvas (multi-canvas)', () => {
    const panels = [
      panel('canvasA', 'canvas'),
      panel('canvasB', 'canvas'),
      panel('term1', 'terminal'),
      panel('term2', 'terminal'),
      panel('term3', 'terminal'),
      panel('term4', 'terminal'),
    ]
    const owners = new Map<string, string>([
      ['term1', 'canvasA'],
      ['term2', 'canvasA'],
      ['term3', 'canvasB'],
      ['term4', 'canvasB'],
    ])

    const { canvasPanels, childrenByCanvas, freePanels, orphanCanvasChildren } =
      partitionWorkspacePanels(panels, owners, null)

    expect(canvasPanels.map((p) => p.id)).toEqual(['canvasA', 'canvasB'])
    expect(childrenByCanvas.canvasA.map((p) => p.id)).toEqual(['term1', 'term2'])
    expect(childrenByCanvas.canvasB.map((p) => p.id)).toEqual(['term3', 'term4'])
    expect(freePanels).toHaveLength(0)
    expect(orphanCanvasChildren).toHaveLength(0)
  })

  // A canvas detached into another window is no longer dock-placed here, so it
  // must drop out of the overview just like a detached docked panel.
  it('hides a canvas that is not placed in this window (detached)', () => {
    const panels = [panel('canvasHere', 'canvas'), panel('canvasGone', 'canvas')]
    const owners = new Map<string, string>()
    const dockPlaced = new Set(['canvasHere']) // canvasGone was detached

    const { canvasPanels } = partitionWorkspacePanels(panels, owners, dockPlaced)

    expect(canvasPanels.map((p) => p.id)).toEqual(['canvasHere'])
  })

  it('shows all canvases when dock placement is unknown (cold start)', () => {
    const panels = [panel('canvasA', 'canvas'), panel('canvasB', 'canvas')]
    const { canvasPanels } = partitionWorkspacePanels(panels, new Map(), null)
    expect(canvasPanels.map((p) => p.id)).toEqual(['canvasA', 'canvasB'])
  })

  it('keeps a docked panel as a free sibling, not a canvas child', () => {
    const panels = [panel('canvasA', 'canvas'), panel('term1', 'terminal')]
    const owners = new Map<string, string>()
    const dockPlaced = new Set(['canvasA', 'term1'])

    const { childrenByCanvas, freePanels } = partitionWorkspacePanels(panels, owners, dockPlaced)

    expect(childrenByCanvas).toEqual({})
    expect(freePanels.map((p) => p.id)).toEqual(['term1'])
  })

  // Ghost filtering: a panel still in workspace.panels but referenced by no
  // canvas and no dock zone must be dropped (it opens nothing).
  it('drops a ghost panel that lives nowhere when dock placement is known', () => {
    const panels = [panel('canvasA', 'canvas'), panel('ghost', 'terminal')]
    const owners = new Map<string, string>()
    const dockPlaced = new Set(['canvasA']) // ghost is not docked

    const { freePanels } = partitionWorkspacePanels(panels, owners, dockPlaced)

    expect(freePanels).toHaveLength(0)
  })

  it('does NOT drop unplaced panels when dock placement is unknown (cold start)', () => {
    const panels = [panel('canvasA', 'canvas'), panel('term1', 'terminal')]
    const owners = new Map<string, string>()

    const { freePanels } = partitionWorkspacePanels(panels, owners, null)

    expect(freePanels.map((p) => p.id)).toEqual(['term1'])
  })

  it('falls back to the first canvas when the owning canvas is gone', () => {
    const panels = [panel('canvasA', 'canvas'), panel('term1', 'terminal')]
    const owners = new Map<string, string>([['term1', 'canvasGone']])

    const { childrenByCanvas, orphanCanvasChildren } = partitionWorkspacePanels(panels, owners, null)

    expect(childrenByCanvas.canvasA.map((p) => p.id)).toEqual(['term1'])
    expect(orphanCanvasChildren).toHaveLength(0)
  })

  it('orphans a canvas child when no canvas panel exists at all', () => {
    const panels = [panel('term1', 'terminal')]
    const owners = new Map<string, string>([['term1', 'canvasGone']])

    const { orphanCanvasChildren, freePanels } = partitionWorkspacePanels(panels, owners, null)

    expect(orphanCanvasChildren.map((p) => p.id)).toEqual(['term1'])
    expect(freePanels).toHaveLength(0)
  })
})

describe('buildColdStartCanvasChildOwners (cold-start per-canvas attribution)', () => {
  // The core regression: a NEVER-MOUNTED secondary canvas's child must be
  // attributed to IT, not lumped under the primary. Each canvas contributes its
  // own nodes' seed panel ids.
  it('attributes each canvas snapshot to its own children', () => {
    const owners = buildColdStartCanvasChildOwners([
      { canvasPanelId: 'canvasA', nodes: [{ panelId: 'term1' }, { panelId: 'term2' }] },
      { canvasPanelId: 'canvasB', nodes: [{ panelId: 'term3' }] },
    ])
    expect(owners.get('term1')).toBe('canvasA')
    expect(owners.get('term2')).toBe('canvasA')
    // The never-mounted secondary canvas's child is attributed to IT, not canvasA.
    expect(owners.get('term3')).toBe('canvasB')
  })

  it('includes a node mini-dock tabbed panels as children of its canvas', () => {
    const owners = buildColdStartCanvasChildOwners([
      {
        canvasPanelId: 'canvasA',
        nodes: [
          {
            panelId: 'seed',
            dockLayout: { type: 'tabs', panelIds: ['seed', 'tab2', 'tab3'] },
          },
        ],
      },
    ])
    expect(owners.get('seed')).toBe('canvasA')
    expect(owners.get('tab2')).toBe('canvasA')
    expect(owners.get('tab3')).toBe('canvasA')
  })

  it('walks split layouts to find every tabbed child', () => {
    const owners = buildColdStartCanvasChildOwners([
      {
        canvasPanelId: 'canvasA',
        nodes: [
          {
            panelId: 'a',
            dockLayout: {
              type: 'split',
              children: [
                { type: 'tabs', panelIds: ['a', 'b'] },
                { type: 'tabs', panelIds: ['c'] },
              ],
            } as never,
          },
        ],
      },
    ])
    expect(owners.get('a')).toBe('canvasA')
    expect(owners.get('b')).toBe('canvasA')
    expect(owners.get('c')).toBe('canvasA')
  })

  it('first canvas wins a tie (deterministic ownership)', () => {
    const owners = buildColdStartCanvasChildOwners([
      { canvasPanelId: 'canvasA', nodes: [{ panelId: 'shared' }] },
      { canvasPanelId: 'canvasB', nodes: [{ panelId: 'shared' }] },
    ])
    expect(owners.get('shared')).toBe('canvasA')
  })

  it('returns an empty map for no snapshots', () => {
    expect(buildColdStartCanvasChildOwners([]).size).toBe(0)
  })
})
