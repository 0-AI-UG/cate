import { afterEach, describe, expect, it, vi } from 'vitest'
import { rect } from '@workspace/canvas/contract'
import { registerPanelDefinitions } from '@client/host'
import { canvasViewFor, resetCanvasViews } from '../../client/layout/canvas'
import { canvasDocument } from '../../client/layout/canvas/testing.canvas'
import { attachTestWorkspace, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { useUIStore } from '../state/uiStore'
import { handleCanvasKey } from './canvas'
import { keyContext } from './useShortcuts'

registerPanelDefinitions(testPanelDefinitions().map((d) => (d.type === 'terminal' ? { ...d, ownsKeyboard: true } : d)))

const del = () => new KeyboardEvent('keydown', { key: 'Delete' })

let ws: TestWorkspace | null = null
afterEach(() => {
  resetCanvasViews()
  ws?.detach()
  ws = null
  useUIStore.setState({ selectedWorkspaceId: null })
})

function setup() {
  ws = attachTestWorkspace('ws', canvasDocument([
    { nodeId: 'a', panelId: 'pa', rect: rect(0, 0, 400, 300) },
    { nodeId: 'b', panelId: 'pb', rect: rect(500, 0, 400, 300) },
  ]))
  useUIStore.setState({ selectedWorkspaceId: 'ws' })
  const store = canvasViewFor('ws', 'c1')!
  const deleteSelection = vi.fn(async () => {})
  store.setState({ deleteSelection })
  return { store, deleteSelection }
}

describe('canvas keys', () => {
  it('Delete closes a multi-selection made after a shell was focused', () => {
    const { store, deleteSelection } = setup()
    store.getState().focusNode('a')
    store.getState().selectNodes(['b'], true)
    expect(keyContext().keyboardOwned).toBe(false)
    expect(handleCanvasKey(del(), keyContext())).toBe(true)
    expect(deleteSelection).toHaveBeenCalledOnce()
  })

  it('a focused shell keeps Delete', () => {
    const { store, deleteSelection } = setup()
    store.getState().focusNode('a')
    expect(keyContext().keyboardOwned).toBe(true)
    expect(handleCanvasKey(del(), keyContext())).toBe(false)
    expect(deleteSelection).not.toHaveBeenCalled()
  })
})
