import { act, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from './Button'
import { Modal } from './Modal'
import { useDismissableLayer } from './Popover'
import { Tooltip } from './Tooltip'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('[role="tooltip"], [role="dialog"]').forEach((node) => node.remove())
  vi.useRealTimers()
})

function render(node: ReactNode): void {
  act(() => root.render(node))
}

describe('shared UI primitives', () => {
  it('shows an associated tooltip from keyboard focus and dismisses it with Escape', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Refresh"><button type="button">Refresh</button></Tooltip>)
    const button = host.querySelector('button')!

    act(() => { button.focus(); vi.runAllTimers() })
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]')
    expect(tooltip?.textContent).toBe('Refresh')
    expect(button.getAttribute('aria-describedby')).toBe(tooltip?.id)

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('renders loading buttons as disabled and busy', () => {
    render(<Button loading loadingLabel="Saving…">Save</Button>)
    const button = host.querySelector('button')!
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent).toContain('Saving…')
    expect(button.querySelector('.animate-spin')).not.toBeNull()
  })

  it('gives modals dialog semantics and associates their title', () => {
    render(<Modal title="Preferences" onClose={() => {}}><button type="button">Done</button></Modal>)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Preferences')
  })

  it('dismisses an open layer on outside pointer input and Escape', () => {
    function Layer() {
      const [open, setOpen] = useState(true)
      const contentRef = useRef<HTMLDivElement>(null)
      useDismissableLayer({ open, contentRef, onDismiss: () => setOpen(false) })
      return open ? <div ref={contentRef}>Menu</div> : <span>Closed</span>
    }
    render(<Layer />)
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(host.textContent).toBe('Closed')
  })
})
