;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { dispatchCanvasToolbarAction, useCanvasToolbarAction } from './useCanvasToolbarAction'

it('targets one canvas and releases its listener on unmount', () => {
  const first = vi.fn(), second = vi.fn()
  function Control({ id, run }: { id: string; run: () => void }) {
    useCanvasToolbarAction('openWorktreeMenu', id, run)
    return null
  }
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<><Control id="one" run={first} /><Control id="two" run={second} /></>))
  act(() => dispatchCanvasToolbarAction('openWorktreeMenu', 'two'))
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledOnce()
  act(() => root.unmount())
  dispatchCanvasToolbarAction('openWorktreeMenu', 'two')
  expect(second).toHaveBeenCalledOnce()
})
