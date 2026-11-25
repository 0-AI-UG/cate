;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { choiceKeys, SurfaceChoiceList } from './SurfaceChoiceList'

it('gives each label its first free letter', () => {
  expect(choiceKeys(['Diff', 'Device', 'Pull request'])).toEqual(['d', 'e', 'p'])
})

it('picks a type when its key is pressed', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onPick = vi.fn()
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  try {
    act(() => root.render(<SurfaceChoiceList choices={[{ type: 'terminal', label: 'Terminal', icon: 'terminal' }, { type: 'browser', label: 'Browser', icon: 'globe' }]} onPick={onPick} />))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', cancelable: true })) })
    expect(onPick).toHaveBeenCalledWith('browser')
  } finally {
    rects.mockRestore()
    act(() => root.unmount())
    host.remove()
  }
})
