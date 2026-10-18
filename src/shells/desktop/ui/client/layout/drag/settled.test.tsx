import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDragStore } from './store'
import { INITIAL_DRAG_STATE } from './types'
import { useDragSettled } from './settled'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const Probe = () => <i>{String(useDragSettled())}</i>
const value = () => host.textContent
const drag = (isDragging: boolean) => act(() => useDragStore.getState().applyDragState({ ...INITIAL_DRAG_STATE, isDragging }))
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

beforeEach(async () => {
  vi.useFakeTimers()
  host = document.createElement('div')
  root = createRoot(host)
  await act(async () => root.render(<Probe />))
})
afterEach(async () => {
  drag(false)
  await act(async () => root.unmount())
  vi.useRealTimers()
})

describe('useDragSettled', () => {
  it('starts false', () => expect(value()).toBe('false'))
  it('is not true at 49ms', () => { drag(true); wait(49); expect(value()).toBe('false') })
  it('is true after 50ms of a drag', () => { drag(true); wait(50); expect(value()).toBe('true') })
  it('is false again when the drag ends', () => { drag(true); wait(50); drag(false); expect(value()).toBe('false') })
})
