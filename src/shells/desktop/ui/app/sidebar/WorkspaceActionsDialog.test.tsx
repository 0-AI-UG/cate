import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { WorkspaceActionsDialog, type WorkspaceAction } from './WorkspaceActionsDialog'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const actions = (run = vi.fn()): WorkspaceAction[] => [
  { id: 'a', label: 'First', icon: null, run: () => run('a') },
  { id: 'b', label: 'Second', icon: null, enabled: false, run: () => run('b') },
  { id: 'c', label: 'Third', icon: null, run: () => run('c') },
]

const press = (key: string) => act(() => {
  document.body.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
})

describe('WorkspaceActionsDialog', () => {
  it('lists the actions with the footer shortcuts', () => {
    act(() => root.render(<WorkspaceActionsDialog name="Demo" actions={actions()} onClose={() => {}} />))
    expect([...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['First1', 'Second2', 'Third3'])
    expect(document.body.textContent).toContain('Navigate')
    expect(document.body.textContent).toContain('Pick')
  })

  it('moves over disabled rows and runs the active one on Enter, closing first', () => {
    const run = vi.fn()
    const onClose = vi.fn()
    act(() => root.render(<WorkspaceActionsDialog name="Demo" actions={actions(run)} onClose={onClose} />))
    press('ArrowDown')
    press('Enter')
    expect(onClose).toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith('c')
  })

  it('picks a row by its digit, but not a disabled one', () => {
    const run = vi.fn()
    act(() => root.render(<WorkspaceActionsDialog name="Demo" actions={actions(run)} onClose={() => {}} />))
    press('2')
    expect(run).not.toHaveBeenCalled()
    press('1')
    expect(run).toHaveBeenCalledWith('a')
  })
})
