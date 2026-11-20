import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ProjectFilter } from './ProjectFilter'

let host: HTMLDivElement
let root: Root
const entries = [
  { id: 'cate', kind: 'local' as const, root: '/cate', name: 'Cate', lastOpenedAt: 1 },
  { id: 'website', kind: 'local' as const, root: '/site', name: 'Website', lastOpenedAt: 1 },
]
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const trigger = () => host.querySelector('button')!

it('uses a styled listbox with the selected project and supports keyboard selection', () => {
  const change = vi.fn()
  act(() => root.render(<ProjectFilter entries={entries} value="" onChange={change} />))
  expect(host.querySelector('select')).toBeNull()
  act(() => trigger().click())
  const list = document.querySelector('[role="listbox"][aria-label="Filter threads by project"]')!
  expect(list.querySelector('[aria-selected="true"]')?.textContent).toBe('All projects')
  const input = document.querySelector('[aria-label="Search projects"]')!
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(change).toHaveBeenCalledWith('cate')
  expect(document.querySelector('[role="listbox"][aria-label="Filter threads by project"]')).toBeNull()
  expect(document.activeElement).toBe(trigger())
})

it('dismisses on Escape or outside click without changing the project', () => {
  const change = vi.fn()
  act(() => root.render(<ProjectFilter entries={entries} value="website" onChange={change} />))
  expect(trigger().textContent).toBe('Website')
  act(() => trigger().click())
  act(() => { document.querySelector('[aria-label="Search projects"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  act(() => trigger().click())
  act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  expect(change).not.toHaveBeenCalled()
})
