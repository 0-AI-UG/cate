import { describe, expect, it } from 'vitest'
import { registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { createDocument, type WorkspaceDocument } from '@workspace/document/contract'
import { placementOptions, planPlacementOn } from './placement'

registerPanelDefinitions(PANEL_DEFINITIONS)

describe('placementOptions', () => {
  it('leaves a panel without a placement to the dock', () => {
    expect(placementOptions('terminal', undefined)).toEqual({})
    expect(placementOptions('terminal', null)).toEqual({})
  })

  it('places near the canvas panel, where there is room without a point', () => {
    expect(placementOptions('terminal', { canvasPanelId: 'c1' })).toEqual({ near: 'c1' })
  })

  it('places a planned spot exactly', () => {
    expect(
      placementOptions('terminal', { canvasPanelId: 'c1', spot: { x: 810, y: 355, width: 400, height: 300 } }),
    ).toEqual({ near: 'c1', position: { x: 810, y: 355 }, size: { width: 400, height: 300 }, exact: true })
  })

  it('centres the panel on the picked point', () => {
    const { width, height } = PANEL_DEFINITIONS.find((definition) => definition.type === 'terminal')!.defaultSize
    expect(placementOptions('terminal', { canvasPanelId: 'c1', point: { x: 1000, y: 500 } })).toEqual({
      near: 'c1',
      position: { x: 1000 - width / 2, y: 500 - height / 2 },
    })
  })
})

describe('planPlacementOn', () => {
  const visible = { x: 0, y: 0, width: 1200, height: 800 }
  const docWith = (nodes: WorkspaceDocument['canvases'][string]['nodes']): WorkspaceDocument => ({
    ...createDocument(),
    panels: { cp: { id: 'cp', type: 'canvas', title: 'Canvas', fields: {}, canvasId: 'c' } },
    canvases: { c: { id: 'c', nodes } },
  })
  const { width, height } = PANEL_DEFINITIONS.find((definition) => definition.type === 'terminal')!.defaultSize

  it('places straight at the centre of an empty canvas', () => {
    expect(planPlacementOn(docWith({}), 'cp', 'terminal', visible)).toEqual({ place: { x: 600 - width / 2, y: 400 - height / 2, width, height } })
  })

  it('offers spots beside the nodes there are', () => {
    const node = { id: 'n1', rect: { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } }, dock: { kind: 'stack' as const, id: 's1', panels: ['a'] } }
    const plan = planPlacementOn(docWith({ n1: node }), 'cp', 'terminal', visible)
    expect(plan && 'pick' in plan && plan.pick.length).toBeGreaterThan(0)
  })

  it('has no plan without the canvas', () => {
    expect(planPlacementOn(docWith({}), 'missing', 'terminal', visible)).toBeNull()
  })
})
