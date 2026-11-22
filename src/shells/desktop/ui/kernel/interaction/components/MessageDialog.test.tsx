import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MessageDialogHost, showMessage } from './MessageDialog'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<MessageDialogHost />)) })
afterEach(() => { act(() => root.unmount()); host.remove() })

it('resolves with the button picked by its number', async () => {
  let result: Promise<number>
  act(() => { result = showMessage({ message: 'Close this canvas?', detail: 'Its panels close too.', buttons: ['Close', 'Cancel'] }) })
  expect(document.body.textContent).toContain('Close this canvas?')
  const rows = [...document.querySelectorAll<HTMLElement>('[data-menu-item]')]
  expect(rows.map((row) => row.dataset.key)).toEqual(['1', '2'])
  act(() => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })) })
  expect(await result!).toBe(0)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('resolves with the cancel button on Escape', async () => {
  let result: Promise<number>
  act(() => { result = showMessage({ message: 'Discard?', buttons: ['Discard', 'Keep'], cancelId: 1 }) })
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(await result!).toBe(1)
})
