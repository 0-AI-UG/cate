import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DropdownSelect } from './DropdownSelect'
import { Modal } from './Modal'
import { useDismissableLayer } from './Popover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]
const key = (key: string) => act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

it('opens at the selected option and supports keyboard selection without search', () => {
  const change = vi.fn()
  act(() => root.render(<DropdownSelect label="Mode" value="b" options={options} onChange={change} />))
  act(() => host.querySelector('button')!.click())
  expect(document.activeElement?.getAttribute('role')).toBe('listbox')
  key('ArrowUp'); key('Enter')
  expect(change).toHaveBeenCalledWith('a')
  expect(document.activeElement).toBe(host.querySelector('button'))
})

it('Escape dismisses only the selector inside a modal', () => {
  const close = vi.fn()
  act(() => root.render(<Modal title="Preferences" onClose={close}><DropdownSelect label="Mode" value="a" options={options} onChange={() => {}} /></Modal>))
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Mode"]')!.click())
  key('Escape')
  expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('[role="listbox"]')).toBeNull()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  key('Escape')
  expect(close).toHaveBeenCalledTimes(1)
})

it('clicking a portaled option keeps its parent menu open', () => {
  const change = vi.fn()
  function Parent() {
    const [open, setOpen] = useState(true)
    const ref = useRef<HTMLDivElement>(null)
    useDismissableLayer({ open, contentRef: ref, onDismiss: () => setOpen(false) })
    return open ? <div ref={ref} data-parent-menu><DropdownSelect label="Mode" value="a" options={options} onChange={change} /></div> : null
  }
  act(() => root.render(<Parent />))
  act(() => host.querySelector('button')!.click())
  const beta = document.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]
  act(() => { beta.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); beta.click() })
  expect(change).toHaveBeenCalledWith('b')
  expect(host.querySelector('[data-parent-menu]')).not.toBeNull()
})
