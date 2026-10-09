import { describe, expect, it } from 'vitest'
import { registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { placementOptions } from './placement'

registerPanelDefinitions(PANEL_DEFINITIONS)

describe('placementOptions', () => {
  it('leaves a panel without a placement to the dock', () => {
    expect(placementOptions('terminal', undefined)).toEqual({})
    expect(placementOptions('terminal', null)).toEqual({})
  })

  it('places near the canvas panel, where there is room without a point', () => {
    expect(placementOptions('terminal', { canvasPanelId: 'c1' })).toEqual({ near: 'c1' })
  })

  it('centres the panel on the picked point', () => {
    const { width, height } = PANEL_DEFINITIONS.find((definition) => definition.type === 'terminal')!.defaultSize
    expect(placementOptions('terminal', { canvasPanelId: 'c1', point: { x: 1000, y: 500 } })).toEqual({
      near: 'c1',
      position: { x: 1000 - width / 2, y: 500 - height / 2 },
    })
  })
})
