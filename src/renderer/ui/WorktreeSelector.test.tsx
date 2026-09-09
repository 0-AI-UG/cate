// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorktreeSelector } from './WorktreeSelector'
import type { JoinedWorktree } from '../stores/useWorktrees'

const worktrees: JoinedWorktree[] = [
  { id: 'main', path: '/repo', branch: 'main', color: '#55aa77', isPrimary: true, isCurrent: true, isOrphan: false },
  { id: 'feature', path: '/feature', branch: 'feature', color: '#aa5577', isPrimary: false, isCurrent: false, isOrphan: false },
  { id: 'gone', path: '/gone', branch: 'gone', isPrimary: false, isCurrent: false, isOrphan: true },
]
let host: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  window.electronAPI.showContextMenu = vi.fn().mockResolvedValue(null)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

it.each([false, true])('expands only overlay selectors on hover (overlay=%s)', async (overlay) => {
  const onHoverChange = vi.fn()
  act(() => root.render(<WorktreeSelector worktrees={worktrees} value="feature" onChange={vi.fn()} title="Worktree" overlay={overlay} onHoverChange={onHoverChange} />))
  const button = host.querySelector('button')!
  const label = button.querySelector('span')!
  expect(label.style.opacity).toBe(overlay ? '0' : '1')
  expect(button.style.backgroundColor).toContain('color-mix')
  act(() => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(label.style.opacity).toBe('1')
  expect(onHoverChange).toHaveBeenLastCalledWith('feature')
  act(() => button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
  expect(label.style.opacity).toBe(overlay ? '0' : '1')
  expect(onHoverChange).toHaveBeenLastCalledWith(null)
})

it('selects a live checkout, marks the current choice, and ignores dismissal or reselecting it', async () => {
  const onChange = vi.fn()
  act(() => root.render(<WorktreeSelector worktrees={worktrees} value="main" onChange={onChange} title="Worktree" />))
  const button = host.querySelector('button')!
  vi.mocked(window.electronAPI.showContextMenu).mockResolvedValueOnce('feature')
  await act(async () => button.click())
  expect(window.electronAPI.showContextMenu).toHaveBeenCalledWith([
    { id: 'main', label: 'main  ✓' }, { id: 'feature', label: 'feature' },
  ])
  expect(onChange).toHaveBeenCalledExactlyOnceWith('feature')
  vi.mocked(window.electronAPI.showContextMenu).mockResolvedValueOnce('main')
  await act(async () => button.click())
  await act(async () => button.click())
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('keeps an overlay expanded while its menu is open and preserves the canvas focus action', async () => {
  let resolve!: (choice: string | null) => void
  vi.mocked(window.electronAPI.showContextMenu).mockImplementation(() => new Promise((done) => { resolve = done }))
  const onSelect = vi.fn()
  const onChange = vi.fn()
  act(() => root.render(<WorktreeSelector worktrees={worktrees} value="main" onChange={onChange} title="Worktree" overlay focusAction={{ label: 'Focus on canvas', onSelect }} />))
  const button = host.querySelector('button')!
  act(() => button.click())
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(button.querySelector('span')!.style.opacity).toBe('1')
  await act(async () => resolve('__focus'))
  expect(onSelect).toHaveBeenCalledOnce()
  expect(onChange).not.toHaveBeenCalled()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(button.querySelector('span')!.style.opacity).toBe('0')
})

it('hides when only one live checkout exists', () => {
  act(() => root.render(<WorktreeSelector worktrees={[worktrees[0], worktrees[2]]} onChange={vi.fn()} title="Worktree" />))
  expect(host.querySelector('button')).toBeNull()
})
