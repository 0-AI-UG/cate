import { describe, expect, it } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { add, buildDocument } from '../../../../../../test/clientWorkspace'
import { primaryCanvasId } from './access'

const doc = buildDocument([
  add('cv1', { to: 'stack', dock: { layoutId: 'main' }, stackId: 's1' }, 'canvas', { canvasId: 'C1' }),
  add('cv2', { to: 'tab', host: { windowId: MAIN_WINDOW }, layoutId: 'T2', stackId: 's2' }, 'canvas', { canvasId: 'C2' }),
])

describe('primaryCanvasId', () => {
  it('is the canvas of the layout the window shows, never one in a hidden layout', () => {
    expect(primaryCanvasId(doc, {})).toBe('C1')
    expect(primaryCanvasId(doc, { main: 'T2' })).toBe('C2')
  })
  it('is null when the shown layout has no canvas', () => {
    const plain = buildDocument([add('t', { to: 'tab', host: { windowId: MAIN_WINDOW }, layoutId: 'T3', stackId: 's3' })], doc)
    expect(primaryCanvasId(plain, { main: 'T3' })).toBeNull()
  })
})
