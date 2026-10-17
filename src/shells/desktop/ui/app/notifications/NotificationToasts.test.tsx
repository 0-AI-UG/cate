import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { NotificationToasts } from './NotificationToasts'
import { createToastStore } from './toasts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { vi.useRealTimers() })

function render(store = createToastStore()) {
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<NotificationToasts store={store} />))
  return { host, store, unmount: () => act(() => root.unmount()) }
}

it('renders toasts and runs the action on click', () => {
  const { host, store, unmount } = render()
  const onClick = vi.fn()
  act(() => { store.show({ title: 'Codex needs input', body: 'Waiting for you.', onClick }) })
  expect(host.textContent).toContain('Codex needs input')
  act(() => { host.querySelector<HTMLButtonElement>('[data-toast-id] button')!.click() })
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[data-toast-id]')).toBeNull()
  unmount()
})

it('dismisses a toast by its button and after its lifetime', () => {
  vi.useFakeTimers()
  const { host, store, unmount } = render(createToastStore(1_000))
  act(() => { store.show({ title: 'a', body: '' }); store.show({ title: 'b', body: '' }) })
  act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click() })
  expect(host.textContent).not.toContain('a')
  expect(host.textContent).toContain('b')
  act(() => { vi.advanceTimersByTime(1_000) })
  expect(host.querySelector('[data-toast-id]')).toBeNull()
  unmount()
})

it('keeps at most four toasts', () => {
  const store = createToastStore()
  for (let i = 0; i < 6; i++) store.show({ title: `t${i}`, body: '' })
  expect(store.getSnapshot().map((t) => t.title)).toEqual(['t2', 't3', 't4', 't5'])
})
