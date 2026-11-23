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
    act(() => root.render(<SurfaceChoiceList acceptBodyKeys choices={[{ type: 'terminal', label: 'Terminal', icon: 'terminal' }, { type: 'browser', label: 'Browser', icon: 'globe' }]} onPick={onPick} />))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', cancelable: true })) })
    expect(onPick).toHaveBeenCalledWith('browser')
  } finally {
    rects.mockRestore()
    act(() => root.unmount())
    host.remove()
  }
})

it('routes a body shortcut to the focused pane when two choosers are visible', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const first = vi.fn()
  const second = vi.fn()
  const choices = [{ type: 'terminal', label: 'Terminal', icon: 'terminal' }]
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  try {
    act(() => root.render(<>
      <div data-dock-stack-id="first"><SurfaceChoiceList choices={choices} onPick={first} /></div>
      <div data-dock-stack-id="second"><SurfaceChoiceList choices={choices} onPick={second} acceptBodyKeys /></div>
    </>))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', cancelable: true })) })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('terminal')
  } finally {
    rects.mockRestore()
    act(() => root.unmount())
    host.remove()
  }
})
